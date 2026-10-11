const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { DateTime } = require("luxon");
const { logger } = require("firebase-functions");
const { createHash } = require("crypto");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();
const TIME_ZONE = process.env.OFFICE_TIMEZONE || "Africa/Cairo";
const REMINDER_WINDOW_MINUTES = 30;
const CLAIM_LEASE_MINUTES = 10;

function caseInstant(item) {
  if (!item.date || item.status === "closed") return null;
  const date = DateTime.fromISO(`${item.date}T${item.time || "09:00"}`, { zone: TIME_ZONE });
  return date.isValid ? date : null;
}

async function claimReminder(reference, now) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.exists && snapshot.get("status") === "sent") return null;
    const claimedAt = snapshot.exists ? snapshot.get("claimedAt")?.toMillis() : 0;
    if (claimedAt && now.toMillis() - claimedAt < CLAIM_LEASE_MINUTES * 60 * 1000) return null;
    transaction.set(reference, { status: "pending", claimedAt: now }, { merge: true });
    return snapshot.exists ? snapshot.get("sentTokens") || [] : [];
  });
}

async function finishReminder(reference, status, sentTokens) {
  await reference.set({
    status,
    sentTokens,
    updatedAt: Timestamp.now()
  }, { merge: true });
}

async function sendReminder(officeReference, item, due, kind, now, reminderType = "session") {
  const key = `${reminderType === "task" ? "task_" : ""}${encodeURIComponent(item.id)}_${due.toUTC().toFormat("yyyyLLddHHmm")}_${kind}`;
  const reminderReference = officeReference.collection("reminders").doc(key);
  let sentTokens = await claimReminder(reminderReference, now);
  if (!sentTokens) return;

  try {
    const devices = await officeReference.collection("devices").get();
    const tokens = devices.docs.map((document) => document.get("token"))
      .filter((token) => typeof token === "string" && token.length > 0)
      .filter((token) => !sentTokens.includes(createHash("sha256").update(token).digest("hex")));
    if (tokens.length) {
      for (let index = 0; index < tokens.length; index += 500) {
        const batch = tokens.slice(index, index + 500);
        const result = await messaging.sendEachForMulticast({
          tokens: batch,
          data: {
            title: reminderType === "task" ? "تذكير بمهام المكتب" : "تذكير بمواعيد مكتبك",
            body: reminderType === "task" ? "لديك مهمة متابعة مستحقة قريبًا. سجّل الدخول لمراجعتها." : "لديك جلسة قريبة. سجّل الدخول إلى بوابة المكتب لمراجعة التفاصيل.",
            url: "/"
          },
          webpush: {
            headers: { Urgency: "high" },
            notification: { icon: "/icon.svg", badge: "/icon.svg", tag: key }
          }
        });
        const staleTokens = [];
        result.responses.forEach((response, tokenIndex) => {
          const token = batch[tokenIndex];
          if (response.success) {
            sentTokens.push(createHash("sha256").update(token).digest("hex"));
          } else if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(response.error?.code)) {
            staleTokens.push(token);
          }
        });
        await Promise.all(staleTokens.map((token) => officeReference.collection("devices").doc(encodeURIComponent(token)).delete()));
        await reminderReference.set({ sentTokens }, { merge: true });
        if (result.failureCount) throw new Error("Some push notifications could not be delivered.");
      }
    }
    await finishReminder(reminderReference, "sent", sentTokens);
  } catch (error) {
    await finishReminder(reminderReference, "failed", sentTokens);
    logger.error("Session reminder delivery failed", { officeId: officeReference.id, reminder: kind, errorCode: error.code || "unknown" });
  }
}

exports.sendSessionReminders = onSchedule({
  schedule: "every 15 minutes",
  timeZone: TIME_ZONE,
  region: "europe-west1",
  maxInstances: 1
}, async () => {
  const now = DateTime.now().setZone(TIME_ZONE);
  const reminderTypes = [
    { name: "day-before", leadMinutes: 24 * 60 },
    { name: "hour-before", leadMinutes: 60 }
  ];
  const offices = await db.collection("offices").get();

  for (const office of offices.docs) {
    const cases = Array.isArray(office.get("cases")) ? office.get("cases") : [];
    for (const item of cases) {
      const due = caseInstant(item);
      if (!due || due <= now) continue;
      for (const reminder of reminderTypes) {
        const target = due.minus({ minutes: reminder.leadMinutes });
        const minutesUntilTarget = target.diff(now, "minutes").minutes;
        if (minutesUntilTarget <= 0 && minutesUntilTarget > -REMINDER_WINDOW_MINUTES) {
          await sendReminder(office.ref, item, due, reminder.name, Timestamp.fromMillis(now.toMillis()));
        }
      }
    }
    const tasks = Array.isArray(office.get("tasks")) ? office.get("tasks") : [];
    for (const task of tasks) {
      if (!task.dueDate || task.done) continue;
      const due = DateTime.fromISO(`${task.dueDate}T09:00`, { zone: TIME_ZONE });
      if (!due.isValid || due <= now) continue;
      for (const reminder of reminderTypes) {
        const target = due.minus({ minutes: reminder.leadMinutes });
        const minutesUntilTarget = target.diff(now, "minutes").minutes;
        if (minutesUntilTarget <= 0 && minutesUntilTarget > -REMINDER_WINDOW_MINUTES) {
          await sendReminder(office.ref, task, due, reminder.name, Timestamp.fromMillis(now.toMillis()), "task");
        }
      }
    }
  }
});
