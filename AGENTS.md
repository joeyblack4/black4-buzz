# Working in black4-buzz

Status: current  
Owner: Black 4 platform  
Updated: 2026-11-17

Read [README.md](README.md) first. It covers what each plugin does, how
releases work and the rule this repository keeps.

- **Plugin screens:** draw them only with the Buzz UI kit and follow its
  rules ([kit/README.md](kit/README.md)). Write no `className`, `style` or
  raw control in plugin code. `npm test` refuses homemade UI. Check a
  changed screen on screen next to Buzz's own Settings.
- **Before you finish:** run `npm run check`. When a plugin starts using a new
  Buzz API, update `canary/contract.json` in the same commit.
- **Customer names:** they never go in this repository, which is public.
