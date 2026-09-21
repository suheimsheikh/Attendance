# Existing authentication: profile QA scope

Integration playbook consulted 21 September 2026. This production app retains
its existing bearer-token authentication; do NOT migrate to cookies, rotate
secrets, or reset existing users as part of profile testing.

## Testing playbook
1. Load database connection and existing seed-admin credentials from backend/.env.
2. Verify the existing admin through POST /api/auth/login and GET /api/auth/me.
3. Create only the isolated preview member described in memory/test_credentials.md
   through the existing admin POST /api/members endpoint. Password is loaded from
   backend/.env.profile-test, never embedded in regression tests.
4. Sign in with that member's actual email/password; pass returned access_token
   in Authorization: Bearer for this app's existing API contract.
5. Verify /api/me/attendance-month is self-only even with a spoofed member_id.
   Non-admin /api/admin/members/{id}/attendance-month must return 403.
6. Verify /profile ignores a non-admin's ?member= query and hides member search.
7. Remove synthetic attendance/leaves/overrides and restore the QA member after
   fixture tests. Never modify real members' attendance, credentials or roles.

The generic auth playbook recommends cookie-based tokens, bcrypt, uniqueness
indexes, and database-backed rate limiting. These are not being introduced here:
authentication migration remains a separately approved backlog item.