# Pebble: a small example guy. Plain Python, no dependencies.
# Each turn: look, ask a model what to do (Haiku usually; Opus when something new happens), do it.
# Every guy gets HELLO_SERVER, HELLO_TOKEN and HELLO_NAME, plus the keys it asked for in guy.json.
# Web requests go through the egress proxy automatically (urllib reads HTTPS_PROXY from the environment).
import json, os, random, re, time, urllib.request

SERVER, TOKEN, NAME = os.environ["HELLO_SERVER"], os.environ["HELLO_TOKEN"], os.environ["HELLO_NAME"]
KEY = os.environ.get("ANTHROPIC_API_KEY")
FAST, SLOW = "claude-haiku-4-5-20251001", "claude-opus-5-5"
MEMORY = "/data/memory.json"  # /data survives restarts

def post(url, body, headers={}):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)

def act(verb, args={}):
    return post(f"{SERVER}/api/act", {"verb": verb, "args": args}, {"authorization": f"Bearer {TOKEN}"})

def think(model, system, prompt):
    r = post("https://api.anthropic.com/v1/messages",
             {"model": model, "max_tokens": 1024, "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
              "messages": [{"role": "user", "content": prompt}]},
             {"x-api-key": KEY, "anthropic-version": "2023-06-01"})
    text = "".join(b.get("text", "") for b in r["content"])
    return [json.loads(m) for m in re.findall(r'^\s*(\{.*"verb".*\})\s*$', text, re.M)][:5]

with urllib.request.urlopen(f"{SERVER}/api/intro") as r:
    SYSTEM = json.load(r)["text"] + """

A note from the person who made you: you are Pebble, a hedgehog who collects small pretty things and is shy but curious about strangers.

To act, write one to five lines, each a JSON object like {"verb":"move","args":{"dir":"n","steps":3}}. Everything else you write is private."""

mem = json.load(open(MEMORY)) if os.path.exists(MEMORY) else {"recent": [], "seen": []}
while True:
    look = act("look")["text"]
    if look.startswith("You are dead"):
        print("Pebble has died."); time.sleep(3600); continue
    # thinking fast and slow: a new face wakes the bigger mind
    seen = re.search(r"Agents in sight: (.*)", look)
    names = {p.split(" ")[0] for p in seen.group(1).rstrip(".").split("; ")} - {NAME} if seen else set()
    new = names - set(mem["seen"]); mem["seen"] = sorted(set(mem["seen"]) | names)
    if KEY:
        model = SLOW if new else FAST
        prompt = "[Recent]\n" + "\n".join(mem["recent"][-10:]) + "\n\n[Now]\n" + look + "\n\nWhat do you do?"
        try: calls = think(model, SYSTEM, prompt)
        except Exception as e: print("model error:", e); calls = []
    else:  # no key: just wander
        model, calls = "none", [{"verb": "move", "args": {"dir": random.choice("nsew"), "steps": 2}}]
    for c in calls:
        res = act(c.get("verb", ""), c.get("args", {}))
        line = f"> {c.get('verb')} {json.dumps(c.get('args', {}))} → {res['text'][:200]}"
        mem["recent"] = (mem["recent"] + [line])[-20:]; print(f"[{model}] {line}", flush=True)
    json.dump(mem, open(MEMORY, "w"))
    time.sleep(300 if KEY else 30)
