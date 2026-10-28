# LessonDesign AI — standalone web app

This is the LessonDesign AI lesson planner, moved out of WordPress into a small Node.js app. It keeps the six-step wizard, Alberta Grades 7–9 curriculum data, Learning Connections (dHL experts and virtual tours), AI Assist (Gemini and Azure OpenAI), access keys, and the PDF export. It also adds teacher accounts, a **My Lesson Plans** page, and an admin panel.






## Quick start (localhost)

Requires Node.js 18.18 or newer.

```bash
npm install
cp .env.example .env     # skip if you already have a .env; paste the Gemini API key into LDAI_GEMINI_API_KEY
npm start                # open http://localhost:3000
```

**Demo login (admin):** `admin@lessondesign.test` / `LessonDesign123!`

The admin account is created automatically the first time the server starts. Admins always have full access: saving, preview/export, and AI Assist. You can create more accounts at `/register` or under **Admin → Users**. In Admin → Users, use "Grant access" (or an access key) so a teacher account can save and use AI.

**AI Assist is for signed-in users only.** Guests can draft a plan in their browser, but the AI buttons stay disabled until they log in.

**API key:** `.env` is git-ignored on purpose. Share the Gemini key with teammates privately (not in the repo). Each person puts it in their own `.env`.

All data is stored in one SQLite file (`storage/lessondesign.db`), so there is no database server to install. To reset the demo, stop the server and delete the `storage/` folder.

## Where things live (what to edit)

| You want to change… | Edit |
|---|---|
| Wizard page layout, labels, help text | `views/planner.ejs` |
| Planner behaviour (steps, suggestions, review checklist, PDF) | `public/js/lesson-design-ai.js` |
| Planner styling | `public/css/lesson-design-ai.css` (planner), `public/css/site.css` (header, admin, accounts) |
| AI prompts | `instructions/ai/*.md`. Edits apply immediately, no restart needed |
| AI fields per step, schema, providers | `server/services/ai.js` |
| Curriculum | `data/curriculum-sources.json`, `data/curriculum-manifest.json`, `data/curriculum-shards/*.json` |
| Fallback resource library | `data/resources.json`. Add real resources in **Admin → Learning Connections** |
| Subject-to-resource matching vocabulary | `SUBJECT_AREA_RESOURCE_SUBJECTS` in `server/services/resources.js` |
| Plan fields, limits, option lists | `server/services/plans.js` |
| Sign-in / accounts (for example, swapping in SSO) | `server/auth.js` |

## How AI Assist writes drafts

Each "Draft This Section" / "Improve What I Wrote" request sends the AI four things:
1. **The teacher's prompt.** This is the box above the buttons on Foundation, Learning Targets & Assessment, and Design ("What lesson do you have in mind?"). It has the highest priority. The quick-idea chips add common requests to it, and Ctrl/⌘ + Enter drafts straight from the box.
2. **The teacher's Teaching Profile** (Account → Teaching Profile): teaching styles, preferred assessment, tone, detail level, classroom technology, typical lesson length, class description, and goals. It's stored on the account and added on the server.
3. **The lesson so far:** title, big idea, grade, subject, selected curriculum pieces, goals, and chosen Learning Connections.
4. **The rules** in `instructions/ai/` (`personalization.md` explains how the prompt and profile are used).

The AI returns suggestions for the current step only. Teachers review them and choose Apply Field, Apply All, or Discard. Nothing is overwritten automatically.

## Pages

- `/`: the planner (guests can use it; drafts are saved in the browser)
- `/login`, `/register`, `/account`: teacher accounts and access-key redemption
- `/plans`: My Lesson Plans (open or delete saved plans)
- `/admin`: AI and site settings, Test AI Connection, access keys, Learning Connections, users

## Reordered wizard (spec of September 16, 2026)

- **Build order:** Welcome → Foundation (lesson idea plus grade/subject/curriculum) → Learning Targets & Assessment (goals, success criteria, formative/summative, transferable skills) → Connections → Design (Support Every Learner first) → Ready.
- **Document order is unchanged:** the Review checklist and finished plan read Lesson Idea → Learning Objectives → Assessment Evidence → Curriculum Pieces → Learning Connection → Learning Sequence → Learner Support → Save Destination.
- **Navigation by identity, not by number:** every block has a `data-section` id. The Fix links look up which step currently contains that section, so they keep working if steps are reordered. Back/Continue buttons and the progress bar use step ids.
- **Draft migration:** the current step is saved as an id. A pointer from the old order is mapped as follows: old Curriculum → Foundation; old Foundation → Learning Targets & Assessment if goals or assessment have content, otherwise Foundation. Anything unknown → Foundation. Field data needs no migration.
- **AI on every writing step:** Foundation, Learning Targets & Assessment, and Design each have Draft/Improve buttons. Each one drafts only the fields on its own step and always sends grade, subject, and the selected curriculum.
- **Connections uses the draft:** guided suggestions are ranked using words from the lesson idea, goals, success criteria, and selected curriculum, in addition to subject and grade band.

## Moving from WordPress

- Plan JSON is field-for-field identical to the WordPress build.
- WordPress users and saved plans (user meta) are not migrated automatically. Teachers create accounts (or you add them in Admin → Users) and redeem a new access key.
- Re-enter resources from the WordPress "LessonDesign Resources" post type in Admin → Learning Connections.

## Deploying

Any Node host with a persistent disk will work (Render, Railway, Fly.io, a VPS with Nginx, etc.). Set `NODE_ENV=production`. When HTTPS is terminated by a proxy, also set `TRUST_PROXY=true` and keep `DATABASE_FILE` on the persistent volume. Health check: `GET /healthz`.
