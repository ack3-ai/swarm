# Sourced by every non-interactive bash an agent starts (BASH_ENV).
# Commands become the first OOM victims, so a runaway build is stopped before the agent.
{ printf 1000 > "/proc/$$/oom_score_adj"; } 2>/dev/null || :
