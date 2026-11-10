import { useEffect, useLayoutEffect, useRef } from 'react';
import { useBanner, useBannerView, useClearBannerOnLeave } from './banner-context.js';
import { BANNER_LABEL, DISMISS } from './copy.js';

export function StatusBanner() {
  const { banner, announcement } = useBannerView();
  useClearBannerOnLeave();
  const region = useRef<HTMLDivElement>(null);
  const activatedInside = useRef(false);
  // A button removed with its banner, or replaced by a banner with other actions, takes the focus with it; the region is a stable place for it to land, so Tab carries on from where the banner was. Only an activation inside the banner moves focus, so the flag is dropped once the event's own updates are drawn.
  useLayoutEffect(() => {
    const lost = activatedInside.current && (document.activeElement === null || document.activeElement === document.body);
    if (lost) region.current?.focus();
  });
  const focusedFor = banner?.moveFocus === true ? banner.id : undefined;
  useEffect(() => {
    if (focusedFor !== undefined) region.current?.focus();
  }, [focusedFor]);
  const markActivation = (): void => {
    activatedInside.current = true;
    setTimeout(() => {
      activatedInside.current = false;
    }, 0);
  };
  return (
    <div className="banner-region" ref={region} tabIndex={-1} onClickCapture={markActivation}>
      <div aria-live="polite" aria-atomic="true" className="visually-hidden">
        {announcement?.tone === 'danger' ? null : announcement?.text}
      </div>
      <div aria-live="assertive" aria-atomic="true" className="visually-hidden">
        {announcement?.tone === 'danger' ? announcement.text : null}
      </div>
      {banner === undefined ? null : <BannerBody />}
    </div>
  );
}

function BannerBody() {
  const controller = useBanner();
  const { banner } = useBannerView();
  if (banner === undefined) return null;
  return (
    <section className={`status-banner status-banner--${banner.tone}`} aria-label={BANNER_LABEL}>
      <span className="status-banner-chip">{banner.chip}</span>
      <div className="status-banner-message">
        <p className="status-banner-headline">{banner.headline}</p>
        <p className="status-banner-text">{banner.text}</p>
      </div>
      {banner.sideLabel === undefined ? null : <span className="status-banner-side">{banner.sideLabel}</span>}
      <div className="status-banner-actions">
        {banner.actions.map((action) => (
          <button key={action.id} type="button" className="secondary" disabled={action.disabled} onClick={action.run}>
            {action.label}
          </button>
        ))}
        {banner.dismissible === false ? null : (
          <button type="button" className="secondary" onClick={() => controller.dismiss(banner.id)}>
            {DISMISS}
          </button>
        )}
      </div>
    </section>
  );
}
