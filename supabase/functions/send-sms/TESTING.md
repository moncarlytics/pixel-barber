# Testing the send-sms Edge Function

## 1. Simulate a Send SMS Hook call directly

The `standardwebhooks` library's signing side can construct a validly-signed test payload without
going through a real Supabase Auth flow. From the repo root:

```bash
node -e "
const crypto = require('crypto');
const fs = require('fs');
const envFile = fs.readFileSync('supabase/.secrets/send-sms.env', 'utf8');
const secretLine = envFile.split('\n').find(l => l.startsWith('SEND_SMS_HOOK_SECRET='));
const secret = secretLine.split('=')[1].replace('v1,whsec_', '');
const payload = JSON.stringify({
  user: { id: 'test-user-id', phone: '233244123456' },
  sms: { otp: '123456' },
});
const id = 'msg_test';
const timestamp = Math.floor(Date.now() / 1000).toString();
const toSign = `${id}.${timestamp}.${payload}`;
const signature = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(toSign).digest('base64');
console.log(JSON.stringify({ id, timestamp, signature: `v1,${signature}`, payload }));
" > /tmp/send-sms-test-payload.json
```

Then POST it to the deployed function with the same headers the library expects:

```bash
PAYLOAD=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/send-sms-test-payload.json')).payload)")
ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/send-sms-test-payload.json')).id)")
TS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/send-sms-test-payload.json')).timestamp)")
SIG=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/send-sms-test-payload.json')).signature)")

curl -i -X POST https://bfkokxcdgvrnevtpeycw.supabase.co/functions/v1/send-sms \
  -H "Content-Type: application/json" \
  -H "svix-id: $ID" \
  -H "svix-timestamp: $TS" \
  -H "svix-signature: $SIG" \
  -d "$PAYLOAD"
```

Expected: `HTTP 200` with body `{}`, AND a real SMS should arrive at +233244123456 if that's a real
number you control and `ARKESEL_SENDER_ID` is a real, registered sender ID (not the `TBD`
placeholder). If `ARKESEL_SENDER_ID` is still `TBD`, expect Arkesel to reject the send — the
function should still respond in a way that reflects that (a 502 from this function, since Arkesel
itself will return a non-success response for an unregistered/invalid sender ID) rather than hanging
or crashing.

## 2. Real end-to-end signup test

Once `ARKESEL_SENDER_ID` is a real registered sender ID:

1. Run the customer app (`npm run dev` in `apps/customer`), open `/onboard`.
2. Enter a real Ghana phone number you control, submit.
3. Confirm a real SMS arrives with a 6-digit code within a reasonable delay.
4. Enter the code, set a password, confirm the flow completes and lands on `/tickets`.

## 3. Signature-rejection test (security check)

Repeat the `curl` command from step 1 but with `SIG` changed to any other string (e.g. append an
extra character). Expected: `HTTP 401` with an error body — confirms the function actually rejects
unsigned/mis-signed requests rather than trusting any caller who knows its URL.
