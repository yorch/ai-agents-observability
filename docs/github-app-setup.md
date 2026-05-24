# GitHub App Setup

## 1. Overview

The GitHub App integration enables the PR bot to read pull request events, post review comments with
telemetry summaries, and react to repository installations. It receives webhook events from GitHub,
enriches them with session cost/tool data from the observability pipeline, and posts structured
summaries back to the PR thread.

See **DESIGN_DOC §7.2** for the full architecture description of the GitHub App integration layer.

---

## 2. Prerequisites

- Access to a GitHub.com organization **or** a GitHub Enterprise Server (GHES) instance where you
  have permission to create GitHub Apps.
- Owner or Admin role on the organization (required to install the App on repositories).

---

## 3. Registration Steps (github.com)

1. Go to **Settings → Developer Settings → GitHub Apps → New GitHub App**
   (`https://github.com/settings/apps/new`).

2. Fill in the basic fields:
   - **GitHub App name** — e.g. `my-org-ai-agents-observability`
   - **Homepage URL** — your deployment URL or the repo URL

3. Set the **Webhook URL** — use a placeholder for now (e.g. `https://example.com/webhooks/github`).
   You will replace this with your real URL (or smee.io channel) before testing.

4. Set **Webhook secret** — generate one with `openssl rand -hex 32` and paste it here. Save the
   value; you will also set it as `GITHUB_APP_WEBHOOK_SECRET` in your environment.

5. Configure **Permissions**:

   | Scope | Access |
   |-------|--------|
   | Pull requests | Read & Write |
   | Contents | Read |
   | Checks | Read |
   | Metadata | Read (mandatory) |
   | Organization members | Read |

6. Subscribe to **Events**:
   - `pull_request`
   - `push`
   - `installation`
   - `installation_repositories`

7. Choose **"Only on this account"** for installation scope (or "Any account" if distributing
   publicly).

8. Click **Create GitHub App**. Note the **App ID** shown on the next page — set it as
   `GITHUB_APP_ID` in your environment.

---

## 4. GHES Variant

The steps are identical but navigate to:

```
https://<GITHUB_HOST>/organizations/<org>/settings/apps/new
```

Replace `<GITHUB_HOST>` with your GHES hostname and `<org>` with the target organization slug.
Set `GITHUB_HOST=<your-ghes-host>` in your environment (already present from the OAuth App block).

---

## 5. Credentials Setup

After creating the App:

1. On the App's settings page, scroll to **Private keys** and click **Generate a private key**.
   A `.pem` file will be downloaded.

2. Base64-encode the key (single line, no line wraps):
   ```bash
   base64 -w0 private-key.pem
   ```

3. Set the environment variables (copy `.env.example` → `.env` and uncomment):
   ```
   GITHUB_APP_ID=<your app id>
   GITHUB_APP_PRIVATE_KEY=<base64-encoded PEM>
   GITHUB_APP_WEBHOOK_SECRET=<the secret you generated in step 4 above>
   ```

4. Delete the downloaded `.pem` file from disk once it is stored securely in your environment or
   secrets manager.

---

## 6. Local Webhook Development with smee.io

For local development you need to expose `localhost:4001` to the internet so GitHub can deliver
webhooks. [smee.io](https://smee.io) provides a free relay channel.

1. Go to [https://smee.io/new](https://smee.io/new) to create a new channel. Copy the channel URL
   (e.g. `https://smee.io/abc123xyz`).

2. Update the **Webhook URL** in your GitHub App settings to the smee.io channel URL.

3. In a separate terminal, start the smee client:
   ```bash
   npx smee-client --url https://smee.io/<channel> --path /webhooks/github --port 4001
   ```

4. Start the GitHub App service locally (`GITHUB_APP_PORT=4001` by default). Webhook events will
   now be relayed from GitHub → smee.io → your local service.

---

## 7. Installing the App on a Repository

1. On the GitHub App's settings page, click **Install App** in the left sidebar.
2. Choose the organization or user account.
3. Select **All repositories** or choose specific repositories.
4. Click **Install**.

Once installed, the App will start receiving `pull_request`, `push`, and `installation` webhook
events for the selected repositories. Verify delivery in **Settings → Developer Settings →
GitHub Apps → \<your app\> → Advanced → Recent Deliveries**.
