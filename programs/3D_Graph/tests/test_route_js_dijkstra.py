"""JS の最短経路（route-core.mjs の bidirectionalDijkstra）が、networkx.bidirectional_dijkstra と
同じ経路を選ぶことの確認。

実データは長さが実数のメートルなので、同じ長さの経路が複数あることはほとんど無い。
ここでは重みを 1 か 2 だけにしたグラフで、同じ長さの経路をわざとたくさん作り、
全部の組み合わせで「どれを選ぶか」まで同じかを見る（探索の順番を networkx と同じにしているため）。
"""
import json
import os
import random
import shutil
import subprocess
from pathlib import Path

import networkx as nx
import pytest

ROOT = Path(__file__).resolve().parents[3]
CORE = ROOT / "programs" / "html" / "shared" / "route-core.mjs"

SCRIPT = """
import { readFileSync } from "node:fs";
import { DiGraph, bidirectionalDijkstra } from %s;
const graphs = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const out = graphs.map(({ nodes, edges }) => {
  const G = new DiGraph();
  for (const n of nodes) G.addNode(n);
  for (const [u, v, w] of edges) G.addEdge(u, v, { weight: w });
  const res = [];
  for (const s of nodes) for (const t of nodes) res.push(bidirectionalDijkstra(G, s, t));
  return res;
});
console.log(JSON.stringify(out));
"""


def random_graph(seed):
    rng = random.Random(seed)
    nodes = rng.sample(range(1, 1000), 30)          # 番号順ではない並びにする
    edges = []
    for _ in range(90):
        u, v = rng.sample(nodes, 2)
        w = rng.choice([1, 2])
        edges.append((u, v, w))
        if rng.random() < 0.7:
            edges.append((v, u, w))                  # 双方向の通路（graph.py と同じく往復2本）
    return nodes, edges


def nx_answers(nodes, edges):
    G = nx.DiGraph()
    G.add_nodes_from(nodes)
    for u, v, w in edges:
        G.add_edge(u, v, weight=w)
    res = []
    for s in nodes:
        for t in nodes:
            try:
                length, path = nx.bidirectional_dijkstra(G, s, t, weight="weight")
                res.append([length, path])
            except nx.NetworkXNoPath:
                res.append(None)
    return res


@pytest.mark.skipif(shutil.which("node") is None and not os.environ.get("CI"), reason="node が無い（CI では必ず動かす）")
def test_同じ長さの経路が複数あっても同じものを選ぶ(tmp_path):
    graphs = [random_graph(seed) for seed in range(20)]
    (tmp_path / "graphs.json").write_text(json.dumps([{"nodes": n, "edges": e} for n, e in graphs]))
    script = tmp_path / "run.mjs"
    script.write_text(SCRIPT % json.dumps(CORE.as_uri()), encoding="utf-8")
    out = subprocess.run(["node", str(script), str(tmp_path / "graphs.json")],
                         check=True, capture_output=True, text=True).stdout
    js = json.loads(out)

    ties = 0
    for (nodes, edges), js_res in zip(graphs, js):
        expected = nx_answers(nodes, edges)
        G = nx.DiGraph()
        for u, v, w in edges:
            G.add_edge(u, v, weight=w)
        for i, (exp, act) in enumerate(zip(expected, js_res)):
            s, t = nodes[i // len(nodes)], nodes[i % len(nodes)]
            assert exp == act, f"{s} → {t}: networkx={exp} / JS={act}"
            if exp and s != t and sum(1 for _ in nx.all_shortest_paths(G, s, t, weight="weight")) > 1:
                ties += 1
    # 同じ長さの経路が複数ある組み合わせを十分に含んでいること（このテストの意味が無くならないように）
    assert ties > 1000, ties
