import { Component, type ReactNode } from 'react';

export const PANEL_FAILED = 'PANEL_FAILED';

interface PanelBoundaryProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** A panel's content comes from the feature that registered it; when it fails to render only that panel shows a notice, and the host goes on. */
export class PanelBoundary extends Component<PanelBoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? (
      <p role="alert" className="panel-failed">
        {this.props.title} · {PANEL_FAILED}
      </p>
    ) : (
      this.props.children
    );
  }
}
