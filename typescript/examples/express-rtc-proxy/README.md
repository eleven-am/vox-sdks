# Vox RTC Express Proxy Example

Tiny Express server that uses `@eleven-am/vox-rtc-server` for the control plane and serves a React browser app that uses `@eleven-am/vox-rtc-client` for WebRTC media.

## Environment

Required:

- `VOX_HTTP_BASE`
- `VOX_API_KEY`

Optional:

- `PORT` (defaults to `8788`)

## Run

```bash
npm install
cd ../../vox-rtc-client && npm install && npm run build
cd ../examples/express-rtc-proxy
VOX_HTTP_BASE=https://vox.horus.maix.ovh VOX_API_KEY=... npm start
```

Open:

- `http://127.0.0.1:8788`

## Shape

- React imports `@eleven-am/vox-rtc-client`
- Browser handles WebRTC media directly with Vox through the client SDK
- Express handles:
  - `POST /api/rtc/session`
  - `GET /api/rtc/session/:id/events`
  - `POST /api/rtc/session/:id/respond`
  - `POST /api/rtc/session/:id/cancel`
  - `POST /api/rtc/session/:id/client-event`
  - `DELETE /api/rtc/session/:id`

This is intentionally a thin test harness, not a production app template.
