importScripts("https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js");
importScripts("/firebase-config.js");

firebase.initializeApp(self.FIREBASE_CONFIG);
const messaging = firebase.messaging();

messaging.setBackgroundMessageHandler((payload) => self.registration.showNotification(
  payload.data?.title || "تذكير بمواعيد مكتبك", {
  body: payload.data?.body || "لديك جلسة قريبة. سجّل الدخول إلى بوابة المكتب لمراجعة التفاصيل.",
  icon: "/icon.svg",
  badge: "/icon.svg",
  data: { url: "/" }
}));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.focus();
    return self.clients.openWindow(event.notification.data?.url || "/");
  }));
});
