import { Component, type ErrorInfo, type ReactNode } from 'react';

interface FlyoutBoundaryProps {
  readonly onFailure: () => void;
  readonly children: ReactNode;
}

/** A flyout's content comes from the feature that registered the tool; when it fails to render, only that flyout is closed and the strip goes on. */
export class FlyoutBoundary extends Component<FlyoutBoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    this.props.onFailure();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
