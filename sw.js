// Service Worker - TBay Web Push
self.addEventListener('push', function(event) {
    let data = { title: 'TBay', body: 'Ujumbe mpya!' };
    
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: 'https://cdn-icons-png.flaticon.com/512/869/869636.png',
        badge: 'https://cdn-icons-png.flaticon.com/512/869/869636.png',
        vibrate: [200, 100, 200],
        data: { url: '/' }
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('/')
    );
});
