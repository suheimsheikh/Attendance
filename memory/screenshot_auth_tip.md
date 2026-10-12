# Authenticated screenshots (screenshot_tool) — reliable recipe

The screenshot tool opens a FRESH browser with no session, and driving the UI
login is flaky. Two gotchas:

1. The app polls (VersionPoller / presence), so `wait_until="networkidle"`
   NEVER settles → `page.goto` times out before your steps run.
2. UI login (phone default → "Admin sign in with email" toggle) is unreliable
   in automation.

## Do this instead — inject the JWT directly:

```python
base = "https://<preview-host>"
resp = await page.request.post(base + "/api/auth/login",
    data={"email": "admin@attendance.app", "password": "Admin@12345"},
    headers={"Content-Type": "application/json"})
token = (await resp.json())["access_token"]
# localStorage key is defined in frontend/src/api.js → TOKEN_KEY
await page.add_init_script("window.localStorage.setItem('ishowedup_token', '" + token + "');")
await page.goto(base + "/admin/reports", wait_until="domcontentloaded")   # NOT networkidle
await page.wait_for_selector('[data-testid="..."]', timeout=20000)
```

- Token key: `ishowedup_token` (localStorage). See frontend/src/api.js.
- A plain API token authenticates the frontend (backend get_current_user
  accepts it; no device handshake needed for already-issued admin tokens).
- Dismiss the daily WhatsApp prompt if present: `button:has-text("Later")`.
- NEVER use the fancy quotes « » in the Playwright script — use ' or ".

## Grid / Reports notes
- The Grid lives at /admin/reports (default "Calendar" tab).
- Month nav: data-testid month-prev / month-next (MonthNav). Name search:
  data-testid calendar-name-search. Half-day leave cells carry
  data-testid=grid-cell-halfday-<iso> and data-half-day=FN|PN.
