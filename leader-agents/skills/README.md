# ECA skills pack

Hermes skills (docs: user-guide/features/skills.md, developer-guide/creating-skills.md) shipped in the
image at /opt/eca/skills and installed by the supervisor into each leader's
`~/.hermes/skills/eca/<name>/` at every workspace start (`install_skills()` in supervisor.py).

- A folder here with a `SKILL.md` is one skill. `DESCRIPTION.md` describes the category.
- `~/.hermes/skills/.eca_manifest.json` records what ECA installed. Only those are replaced or
  removed; a leader's own skills are never touched. A leader's edit to an ECA skill is moved to
  `~/.hermes/eca-skills-replaced/` before ECA's version is put back.
- Tool names and arguments come from the backend (`app/intel/tools.py`, `data_tools.py`). Reply cards
  are the fenced JSON blocks described in the SOUL text in supervisor.py.
- To change a skill: edit it here and push. To retire one: delete its folder and push.
