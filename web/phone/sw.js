// Shows Gnosis notifications pushed from the laptop, and opens the app when one is tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {title: "Gnosis", body: ""};
  try { data = {...data, ...event.data.json()}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: "icon.svg", badge: "icon.svg", data: {url: data.url || "./"},
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    if (windows.length) return windows[0].focus();
    return self.clients.openWindow(event.notification.data.url);
  })());
});
