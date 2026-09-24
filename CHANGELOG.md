# Changelog

## 0.1.4

- Office chat: click a character to open its conversation in a side panel, with messages, reasoning and tool calls, updated live; send it a message in its current conversation or a new one. Replaces the prompt dialog.
- Meetings: agents working in the same conversation tree (a lead and the sub-agents it started) gather around the lead's desk, with a *Meeting* marker. The meeting thread shows the briefs sent to each agent and their work; a message sent to a meeting goes to the lead, optionally after stopping the whole team.
- Stop buttons for one agent (with the sub-agents it started), a meeting, or everyone.
- Calmer office: slower walking, idle agents stay at quiet spots (coffee table, bookshelf, armchair) and move now and then; agents jump to their spot when the office becomes visible again.
- *Create a Virtual Team of Agents*: presets (*Software team*, *Kubernetes & Go*), rewritten role prompts with a shared report format, and new roles: k8s-architect, go-developer, go-tester, sre, security-reviewer. The manager must delegate with the `task` tool.
- Kilo plugin: `abort` and `messages` commands. Conversation text is only read while a chat or meeting is open in the office.
- README: English only.

## 0.1.3

- Prompts sent from the office use the same model as Kilo Code: the model picked for the agent, else the last model picked, else `model` from the Kilo config, else Kilo Code's default-model settings. Agents with their own `model` and continued conversations keep theirs. Also applies to `ask_teammate`.
- *Create a Virtual Team of Agents*: new `manager` (primary agent that dispatches work to the other agents) and `ux-designer` roles. Selected by default: manager, architect, ux-designer, developer, tester.

## 0.1.2

- README: what *Connect* and *Disconnect* change in the Kilo config folder, proxy handling, the ★ view.

## 0.1.1

- Kilo plugin: requests to the Star UI bridge use `node:http`; `127.0.0.1`, `localhost` and `::1` are added to `NO_PROXY` in the Kilo process.
- Kilo plugin: `ask_teammate` declares its arguments as JSON Schema and no longer imports `@kilocode/plugin`.
- *Connect to Kilo Code*: when Star UI's plugin is the only plugin in the Kilo config folder and `@kilocode/plugin` is not installed, records `@kilocode/plugin` in `package.json` and `package-lock.json` and creates `node_modules/`. Kilo then skips its `npm install @kilocode/plugin` step.
- ★ Star Office view in the activity bar; the office opens on first activation.
- Warning when Kilo Code is older than 7.
- Tested with Kilo Code 7.6.2 and 7.7.9.

## 0.1.0

First release: the Star-Office-UI pixel office, rebuilt as a VS Code extension for Kilo Code.

- Kilo plugin (`~/.config/kilo/plugin/star-ui-kilo.js`) that forwards a summary of Kilo Code activity to a local bridge, installed with *Connect to Kilo Code*.
- One character per Kilo agent: built-in agents, sub-agents, custom agents and cross-repo teammates, with live states (desk, bug corner, sync corner, lounge) and "needs you" alerts.
- Click a character to prompt it in Kilo Code, in a new or the current conversation; open its conversation in Kilo Code.
- *Create a Virtual Team of Agents*: ready-made Kilo agents (architect, developer, reviewer, tester, docs, devops).
- Cross-repository teammates (`~/.star-ui-kilo/team.json`) and the `ask_teammate` tool.
- Activity log, team list, Kilo link panel, status bar item, demo mode, English and French UI, "office" and "lodge" rooms.
