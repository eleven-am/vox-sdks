# Vox RTC Express Proxy Example

Tiny Express server that uses `@eleven-am/vox-rtc-server` for the control plane and serves a browser page from the same origin for manual testing.

## Environment

Required:

- `VOX_HTTP_BASE`
- `VOX_API_KEY`

Optional:

- `PORT` (defaults to `8788`)

## Run

```bash
npm install
VOX_HTTP_BASE=https://vox.horus.maix.ovh VOX_API_KEY=... npm start
```

Open:

- `http://127.0.0.1:8788`

## Shape

- Browser handles WebRTC media directly with Vox
- Express handles:
  - `POST /api/rtc/session`
  - `GET /api/rtc/session/:id/events`
  - `POST /api/rtc/session/:id/respond`
  - `POST /api/rtc/session/:id/cancel`
  - `POST /api/rtc/session/:id/client-event`
  - `DELETE /api/rtc/session/:id`

This is intentionally a thin test harness, not a production app template.
