# Ruang / PDT06

Ruang is a static classroom discussion interface backed by Netlify Functions and Netlify Blobs. The projector and phone UIs, media tools, question controls, QR generation, and styling are served from `public/index.html`. There is no Firebase project, external database, frontend framework, or always-running server.

## Deploy from GitHub to Netlify

1. Push this repository to GitHub.
2. Sign in to Netlify and choose **Add new site > Import an existing project**.
3. Connect GitHub and select this repository and deployment branch.
4. Keep the repository root as the **Base directory** and use the committed `netlify.toml` settings:
   - Build command: `npm run build`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
   - Node.js: 22
5. Choose **Deploy site**. Netlify installs the pinned npm dependencies, builds the QR asset, and deploys the static site and function together.
6. Open the deployed HTTPS address. On the projector, choose **Connect devices** and **Create classroom session**. Share the generated QR code or student link.

No manually pasted Netlify token, site ID, Firebase value, or database credential is needed for a Git-based deployment. Netlify supplies the function credentials for the site's Blobs store. Netlify plan features, quotas, usage charges, and limits vary; check the current terms for the account and plan you choose. This project does not promise unlimited storage or function requests.

Dragging only an `index.html` file into a static upload does **not** deploy the functions or shared Blobs storage. Use the complete Git repository import so Netlify can build `netlify/functions/api.mjs` as well as publish `public/`.

## Update the deployed site

Edit the tracked source files, commit, and push to the connected deployment branch. Netlify automatically builds and publishes the new version. To preview changes, use a Git branch or Netlify Deploy Preview. Do not copy only `public/index.html` into a static upload; classroom operations need the deployed function.

## Project files

- `public/index.html` — active static interface, styles, and browser logic.
- `public/vendor/qrcode.js` — generated during build from the pinned local `qrcode-generator` dependency.
- `netlify/functions/api.mjs` — same-origin API for room creation, snapshots, question submissions, and moderation.
- `netlify.toml` — explicit build, publish, and functions configuration.
- `package.json` / `package-lock.json` — pinned dependencies and build/test scripts.
- `scripts/build.mjs` — copies the QR encoder into the publish directory.
- `tests/api.test.mjs` — storage-operation tests using an in-memory implementation of the Blobs conditional-write API.
- `ruang.html` — preserved original source copy; it is not deployed.

The root `index.html` is a repository pointer. Netlify serves `public/index.html` as configured.

## Local development and checks

Use Node.js 22 and npm:

```sh
npm ci
npm test
npm run build
npm run dev
```

`npm run build` prepares the local QR asset. `npm run dev` runs the pinned Netlify CLI in offline mode, serving the static site and functions together with local Blobs emulation. The CLI is fetched by `npx` when needed rather than installed as an application dependency. Local emulation and the API tests do not claim to verify production storage or cross-device behavior.

## Rooms, storage, and privacy

- Netlify Blobs stores each room state and each question as separate records. Room state changes and question moderation use conditional ETag writes; submissions use stable IDs and create-only writes so retries do not duplicate comments.
- The store opts into **strong consistency**, rather than Blobs' default eventual consistency, so acknowledged updates are available to subsequent polling reads. The tradeoff is slower reads.
- The browser polls approximately every two seconds while visible, prevents overlapping polls, backs off after failures, and retries promptly after focus or network recovery. Draft text remains in the composer and local browser storage until the server confirms receipt.
- The presenter receives a random owner token once when a room is created. Only its SHA-256 hash is stored with the room. The raw token is saved in local storage under a key scoped to that room and is never placed in student URLs or QR codes. Clearing that browser's site data loses the recovery token; create a new room if it cannot be recovered.
- Student links contain only `?view=student&room=...`. Students are anonymous; names and account details are not requested or stored.
- Clearing advances the room's question generation before removing the old question records. Late requests and retries from that generation remain invisible. Small hash-only submission records are retained to make retry handling safe; if physical cleanup encounters a storage error, the API reports that cleanup is pending.
- Questions have no application-defined character limit. Netlify's request, storage, function, and plan quotas still apply; oversized requests return an explicit error and keep the draft in the browser.
- YouTube playback requires internet. Camera input and local image/video files stay on the projector device and are never uploaded.

The active app no longer uses Firebase. `ruang.html` is retained solely as the original source copy and is not included in the Netlify publish directory.
