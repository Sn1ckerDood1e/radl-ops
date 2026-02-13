# Cron Setup for Automated Briefings

## Add These Lines to Crontab

Run `crontab -e` and add:

```cron
# Radl Ops Daily Briefing - Mon-Fri at 7:00 AM
0 7 * * 1-5 /home/hb/radl-ops/scripts/daily-briefing.sh >> /home/hb/radl-ops/logs/daily.log 2>&1

# Radl Ops Weekly Briefing - Saturday at 7:00 AM
0 7 * * 6 /home/hb/radl-ops/scripts/weekly-briefing.sh >> /home/hb/radl-ops/logs/weekly.log 2>&1
```

## Create Log Directory

```bash
mkdir -p /home/hb/radl-ops/logs
```

## Test Manually First

```bash
# Test daily briefing
/home/hb/radl-ops/scripts/daily-briefing.sh

# Check output
cat /home/hb/radl-ops/briefings/daily-$(date +%Y-%m-%d).md
```

## Email Setup (TODO)

The scripts save briefings to files. To enable email delivery:

### Option 1: System Mail (if configured)
Uncomment the `mail` line in the scripts.

### Option 2: Resend API
Add to scripts:
```bash
curl -X POST 'https://api.resend.com/emails' \
  -H 'Authorization: Bearer YOUR_RESEND_API_KEY' \
  -H 'Content-Type: application/json' \
  -d "{
    \"from\": \"radl-ops@yourdomain.com\",
    \"to\": \"$BRIEFING_EMAIL\",
    \"subject\": \"Radl Daily Briefing - $DATE\",
    \"text\": \"$(cat $BRIEFING_FILE)\"
  }"
```

### Option 3: SendGrid, Mailgun, etc.
Similar curl approach with respective APIs.

## Verify Cron is Running

```bash
# Check cron service
systemctl status cron

# View cron logs
grep CRON /var/log/syslog | tail -20
```

## Timezone

Cron uses system timezone. Check with:
```bash
timedatectl
```

If you need a different timezone for 7am, adjust the cron hour accordingly.
