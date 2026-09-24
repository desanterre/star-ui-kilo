# Releasing

Releases are built and published by GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)) when a `v*` tag is pushed.

## Security model

| What | Who | How it is enforced |
|---|---|---|
| Push to `main` | repository owner only | ruleset "Protect main": updates, force pushes and deletion are restricted to repository admins |
| Create / move / delete `v*` tags (releases) | repository owner only | ruleset "Protect release tags" |
| Run the publish job | repository owner only | environment `marketplace` requires the owner's approval and only accepts `v*` tags |
| Read publishing credentials | nobody | GitHub secrets are write-only (no one can read them back, not even the owner). They live in the `marketplace` environment, so only the approved publish job can use them |
| Fork pull requests | anyone | CI runs with a read-only token and no secrets; workflows from outside contributors need the owner's approval |

Actions are pinned to full commit SHAs. The CI job never has access to secrets.

## One-time setup

1. **Publisher.** On <https://marketplace.visualstudio.com/manage>, create a publisher. Its ID must match `"publisher"` in `package.json` (currently `desanterre`).
2. **Marketplace credentials (optional).** The simplest way needs none: upload the `.vsix` by hand (see "Cutting a release"). Automated publishing needs one of these:

   **Option A: Microsoft Entra ID (recommended, no stored secret).** Azure DevOps retires global personal access tokens on December 1, 2026. After that date, this is the supported way to publish from CI.
   - In Azure, create a user-assigned managed identity. Add a federated credential for GitHub Actions: organization `desanterre`, repository `star-ui-kilo`, entity type **Environment**, environment `marketplace`.
   - Add the identity as a **Contributor** member of your Marketplace publisher, as described in [Publishing Extensions › Microsoft Entra ID](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
   - In the repository, go to **Settings › Environments › marketplace › Environment variables** and add `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. These values are identifiers, not secrets.

   **Option B: personal access token (works until December 1, 2026; needs an Azure DevOps organization, which now requires an Azure subscription).**
   - In Azure DevOps, go to **User settings › Personal access tokens**, then **New token**. Set Organization to **All accessible organizations** and Scopes to **Marketplace › Manage**, and keep the expiry short.
   - Store it without writing it anywhere. The command prompts for the value, so the token never ends up in your shell history:

     ```bash
     gh secret set VSCE_PAT --env marketplace --repo desanterre/star-ui-kilo
     ```

3. **Open VSX (Cursor, VSCodium, Windsurf, and private mirrors).** The `desanterre` namespace exists and the publisher agreement is signed.
   - Without credentials: upload the `.vsix` on <https://open-vsx.org/user-settings/extensions> (**Publish extension**). New versions go through a short review before they are public.
   - Automated, with a token: on <https://open-vsx.org/user-settings/tokens>, generate a token, then store it (the command prompts for it):

     ```bash
     gh secret set OVSX_PAT --env marketplace --repo desanterre/star-ui-kilo
     ```

   - Automated, without a stored token: once open-vsx.org lets you register a trusted publisher (repository `desanterre/star-ui-kilo`, workflow `release.yml`, environment `marketplace`), set the `OPENVSX_TRUSTED_PUBLISHING` environment variable to `true`. The workflow then exchanges its OIDC token for a short-lived one.

## Cutting a release

```bash
npm version patch --no-git-tag-version   # or minor / major
# update CHANGELOG.md
git commit -am "Release vX.Y.Z"
git push
git tag vX.Y.Z && git push origin vX.Y.Z
```

Then open **Actions › Release** and approve the `marketplace` deployment. The workflow checks that the tag matches `package.json`, runs the tests, packages the `.vsix`, publishes it to the Marketplace and Open VSX when credentials are configured, and always attaches it to a GitHub release.

**Without Marketplace credentials:** download the `.vsix` from the GitHub release (or build it with `npm run package`). Then on <https://marketplace.visualstudio.com/manage/publishers/desanterre>:
- first release: **New extension › Visual Studio Code**, then drop the file;
- later releases: **⋯ › Update** on the extension, then drop the new file.
