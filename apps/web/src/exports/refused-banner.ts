import type { BannerController } from '../banner/banner-controller.js';
import { EXPORT_AGAIN, REFUSED_BANNER_ID, REFUSED_CHIP, REFUSED_HEADLINE, REFUSED_TEXT, SOURCE_REFUSED_HEADLINE, SOURCE_REFUSED_TEXT } from './copy.js';

/** The banner of a download that was refused because access changed: it never says what changed, and offers a new export. */
export function showDownloadRefused(banner: BannerController, exportAgain: () => void): void {
  banner.show({
    id: REFUSED_BANNER_ID,
    tone: 'warning',
    chip: REFUSED_CHIP,
    headline: REFUSED_HEADLINE,
    text: REFUSED_TEXT,
    dismissible: true,
    moveFocus: true,
    actions: [
      {
        id: 'export-again',
        label: EXPORT_AGAIN,
        primary: true,
        run: () => {
          banner.dismiss(REFUSED_BANNER_ID);
          exportAgain();
        },
      },
    ],
  });
}

/** The banner of a download that was refused because the source of the export changed: no new export is offered, since none can be made while the source is changed. */
export function showDownloadSourceChanged(banner: BannerController): void {
  banner.show({ id: REFUSED_BANNER_ID, tone: 'warning', chip: REFUSED_CHIP, headline: SOURCE_REFUSED_HEADLINE, text: SOURCE_REFUSED_TEXT, dismissible: true, moveFocus: true, actions: [] });
}
