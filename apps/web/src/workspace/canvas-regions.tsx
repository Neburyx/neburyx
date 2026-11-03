import { useOccupant, type SlotName } from './slots.js';

const REGIONS: readonly { readonly slot: SlotName; readonly className: string }[] = [
  { slot: 'tool-strip', className: 'region-tool-strip' },
  { slot: 'toggles', className: 'region-toggles' },
  { slot: 'zoom-controls', className: 'region-zoom-controls' },
  { slot: 'dock', className: 'region-dock' },
  { slot: 'floating', className: 'region-floating' },
];

function Region({ slot, className }: { readonly slot: SlotName; readonly className: string }) {
  const Occupant = useOccupant(slot);
  if (Occupant === undefined) return null;
  return (
    <div className={`region ${className}`}>
      <Occupant />
    </div>
  );
}

export function CanvasRegions() {
  return (
    <>
      {REGIONS.map((region) => (
        <Region key={region.slot} {...region} />
      ))}
    </>
  );
}
