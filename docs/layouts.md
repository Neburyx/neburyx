# Layouts and physics

The layout control at the bottom right of the canvas arranges what is loaded and shown. A layout never fetches anything and never changes the graph; it only gives entities positions.

## The layouts

| Layout | What it does |
|---|---|
| Force (the default) | Pulls related entities together and pushes the others apart. |
| Hierarchical | Layers entities along the direction of their relationships, so a flow A → B → C reads down the page. The direction is "Top to bottom" (the default) or "Left to right". A cycle is broken where it closes. |
| Radial | Puts one entity in the middle and its neighbors on rings around it, ring by ring by number of hops. The middle is the first selected entity, otherwise the entity with the most neighbors shown. Entities with no path to the middle sit in a block outside the last ring. |
| Grid | Puts every entity in its own cell, row by row in the loaded order. |

Choosing a layout, or choosing it again, runs it once and fits the view to the shown entities. Entities placed on their own after an expansion do not move the view.

Every layout leaves a pinned entity where it is, and places the others clear of it. Entities that are hidden, out of focus, switched off by a type filter or collapsed take no part and keep their positions. No two boxes overlap.

## Physics

The **Physics** switch is off by default. Off, a layout runs once and stops. On, the force layout keeps running: dragging an entity pulls its neighbors, and the graph settles on its own and then stops computing. A dropped entity stays where it was dropped until another entity is grabbed.

- Physics works with Force only; under the other layouts the switch is disabled.
- Nothing is computed while the browser tab is hidden, after the switch is turned off, or when the canvas goes away.
- Pinned entities never move.
- Positions are stored when the entities settle or the loop stops, not on every frame.

### Limits

Measured with the browser at 4× CPU throttle, dragging one entity, on the synthetic fixture grown by 25 entities at a time:

| Shown entities | Drawing | Result |
|---|---|---|
| up to 300 | every frame | median 59.9 fps, 5th percentile 59.5 fps |
| 301 to 450 | every second frame | the same at 445 entities |
| above 450 | the switch is disabled ("Physics is off above 450 entities") | 595 and 995 entities fell below a 5th percentile of 30 fps even drawn every third frame |

The browser benchmark (`tools/ux/tests/benchmark-layouts.spec.ts`) guards the 300-element case: no frame over 100 ms on a laptop (300 ms on the CI runner) while a layout runs, and a median of 55 fps and a 5th percentile of 30 fps (25 on the CI runner) while dragging with Physics on. Computing a layout takes about 2 ms (Force about 10 ms) for that canvas; the longest frame is the drawing of every entity again, which is why the runner's limit is the pan and zoom guard's 300 ms (`tools/ux/src/rates.ts` holds the figures). The measurement is of the browser's frame rate on one machine; it says nothing about other hardware.

## What is saved

The layout, the hierarchical direction and the Physics setting are part of the view's presentation state, kept with the positions and pins when an investigation is set aside and resumed in a session. They are not yet saved in a stored view.
