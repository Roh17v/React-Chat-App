# Android APK CI — step-by-step

## Goal

Every merge/push to **`main`** that touches `frontend/**` (or a manual run):

1. Builds the Vite web app (with secrets)
2. Writes `google-services.json` from a secret
3. Runs `npx cap sync android`
4. Builds a **debug** APK
5. Publishes GitHub Release **`apk-latest`** with `synchronus.apk` + `latest.json`

**Stable download URL (portfolio):**  
https://github.com/Roh17v/React-Chat-App/releases/latest/download/synchronus.apk

---

## Required GitHub secrets

https://github.com/Roh17v/React-Chat-App/settings/secrets/actions

| Secret | Source |
|--------|--------|
| `VITE_BASE_URL` | frontend `.env` |
| `VITE_FIREBASE_*` | frontend `.env` (all Firebase keys) |
| `GOOGLE_SERVICES_JSON_BASE64` | base64 of `frontend/android/app/google-services.json` |

Encode `google-services.json` (PowerShell):

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("frontend\android\app\google-services.json")
) | Set-Clipboard
```

Paste into secret **without quotes**. Do **not** commit `google-services.json`.

---

## Triggers

| Event | Rebuild? |
|--------|----------|
| Merge PR / push to `main` under `frontend/**` | Yes |
| Only backend changes | No |
| Actions → Build Android APK → Run workflow | Yes |

---

## Local Windows

Do not set `org.gradle.java.home` to a Windows path in the committed `gradle.properties` (breaks Linux CI). Use `JAVA_HOME` locally instead.
