"""Render the blog cover card for the saas-har benchmark from results-public.json.

    python3 scripts/cover_card.py paper/results-public.json card.svg
    rsvg-convert -z 2 card.svg -o ../../docs/public/assets/blog/every-pull-request-left-a-proof.png

One box per scored pair, ordered by repository then instance.
"""
import json, sys

d = json.load(open(sys.argv[1]))
rows = sorted(d["instances"], key=lambda r: (r["repo"], r["short"]))
assert len(rows) == 35

W, H = 1200, 675
BG, FG, MUTED, DIM = "#0d1117", "#e6edf3", "#8b949e", "#30363d"
GREEN, GREY, RED = "#38c976", "#3a4250", "#f2545b"
F = "DejaVu Sans"
MONO = "JetBrainsMono NF"

o = []
a = o.append
a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
a(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
a(f'<text x="60" y="78" font-family="{MONO}" font-size="16" fill="{GREEN}" letter-spacing="2">BENCHMARK · 35 MERGED PULL REQUESTS · CLAUDE OPUS</text>')
a(f'<text x="60" y="130" font-family="{F}" font-size="44" font-weight="bold" fill="{FG}">Every pull request left a proof.</text>')
a(f'<text x="60" y="170" font-family="{F}" font-size="20" fill="{MUTED}">Same model, same prompt, nobody told to test. One repo had a HAR harness.</text>')

# grids
S, G = 26, 6  # box size, gap
gx = 60
def grid(y, label, sub, cell):
    a(f'<text x="{gx}" y="{y-14}" font-family="{F}" font-size="18" font-weight="bold" fill="{FG}">{label}</text>')
    a(f'<text x="{gx + (175 if label.startswith("With") else 210)}" y="{y-14}" font-family="{F}" font-size="15" fill="{MUTED}">{sub}</text>')
    for i, r in enumerate(rows):
        c, rr = i % 18, i // 18
        x, yy = gx + c * (S + G), y + rr * (S + G)
        a(cell(x, yy, r))

def dot(x, y, on):
    return f'<circle cx="{x+S/2}" cy="{y+S/2}" r="4.5" fill="{BG}"/>' if on else ""

def har_cell(x, y, r):
    return f'<rect x="{x}" y="{y}" width="{S}" height="{S}" rx="4" fill="{GREEN}"/>' + dot(x, y, r["har_resolved"])

def raw_cell(x, y, r):
    if r["raw_verified_anything"]:
        s = f'<rect x="{x}" y="{y}" width="{S}" height="{S}" rx="4" fill="{GREY}"/>'
        return s + (f'<circle cx="{x+S/2}" cy="{y+S/2}" r="4.5" fill="{FG}"/>' if r["raw_resolved"] else "")
    s = f'<rect x="{x+1}" y="{y+1}" width="{S-2}" height="{S-2}" rx="4" fill="none" stroke="{RED}" stroke-width="2" stroke-dasharray="4 3"/>'
    return s + (f'<circle cx="{x+S/2}" cy="{y+S/2}" r="4.5" fill="{RED}"/>' if r["raw_resolved"] else "")

grid(250, "With HAR", "full pipeline ran and was recorded: 35/35", har_cell)
grid(400, "Plain Claude Code", "some check in the log: 25/35 · nothing at all: 10/35", raw_cell)

# legend
ly = 500
a(f'<rect x="{gx}" y="{ly}" width="14" height="14" rx="3" fill="{GREEN}"/>')
a(f'<text x="{gx+22}" y="{ly+12}" font-family="{F}" font-size="14" fill="{MUTED}">recorded pipeline run</text>')
a(f'<rect x="{gx+190}" y="{ly}" width="14" height="14" rx="3" fill="{GREY}"/>')
a(f'<text x="{gx+212}" y="{ly+12}" font-family="{F}" font-size="14" fill="{MUTED}">unrecorded check</text>')
a(f'<rect x="{gx+352}" y="{ly+1}" width="12" height="12" rx="3" fill="none" stroke="{RED}" stroke-width="2" stroke-dasharray="3 2"/>')
a(f'<text x="{gx+373}" y="{ly+12}" font-family="{F}" font-size="14" fill="{MUTED}">no check</text>')
a(f'<circle cx="{gx+460}" cy="{ly+7}" r="4.5" fill="{MUTED}"/>')
a(f'<text x="{gx+472}" y="{ly+12}" font-family="{F}" font-size="14" fill="{MUTED}">resolved</text>')

# stats column
sx = 720
a(f'<line x1="{sx-30}" y1="215" x2="{sx-30}" y2="520" stroke="{DIM}" stroke-width="1"/>')
def stat(y, big_l, big_r, cap):
    a(f'<text xml:space="preserve" x="{sx}" y="{y}" font-family="{F}" font-size="46" font-weight="bold" fill="{GREEN}">{big_l}'
      f'<tspan font-size="22" font-weight="normal" fill="{MUTED}">  vs  </tspan>'
      f'<tspan fill="{FG}">{big_r}</tspan></text>')
    a(f'<text x="{sx}" y="{y+30}" font-family="{F}" font-size="17" fill="{MUTED}">{cap}</text>')

stat(265, "0", "10", "pull requests shipped with no check run")
stat(370, "35", "0", "full verification pipeline runs recorded")
stat(475, "19", "17", "resolved by hidden tests: no loss in correctness")

# footer
a(f'<line x1="60" y1="580" x2="{W-60}" y2="580" stroke="{DIM}" stroke-width="1"/>')
a(f'<text x="60" y="618" font-family="{F}" font-size="15" fill="{MUTED}">Every HAR session that started ran the full pipeline (36/36). Resolve gap is within noise (McNemar p = 0.625).</text>')
a(f'<text x="{W-60}" y="618" text-anchor="end" font-family="{MONO}" font-size="16" font-weight="bold" fill="{FG}">harproject.dev</text>')
a("</svg>")
open(sys.argv[2], "w").write("\n".join(o))
