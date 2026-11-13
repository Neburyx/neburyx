MATCH (a:`Maker`) WHERE a.`makerId` IN [$stableId, $stableInteger] WITH a ORDER BY elementId(a) LIMIT 1
CALL { WITH a CALL { WITH a MATCH (a)-[r1:`LINKS`]->(n1:`Maker`) WHERE n1 <> a AND (n1.`region` IS :: STRING NOT NULL AND n1.`region` = $steps[0].conditions[0].value.value) RETURN n1, r1 } WITH n1, r1 LIMIT $countCap + 1 WITH collect({n1: n1, r1: r1}) AS found RETURN size(found) > $countCap AS cut1, found[..$countCap] AS f1 }
WITH a, cut1 AS bounded, [] AS heavy, false AS stopListed, f1 AS paths
CALL { WITH paths UNWIND paths AS p WITH p ORDER BY p.n1.`makerId` WITH p.n1 AS x, collect(p)[0] AS best ORDER BY x.`makerId` LIMIT $limit + 1 RETURN collect(best) AS ms }
UNWIND CASE WHEN size(ms) = 0 THEN [null] ELSE ms END AS m
RETURN a, bounded, heavy[..$limit] AS heavy, stopListed, m.n1 AS x, [] AS mid, m.r1 AS r1, 1 AS hops