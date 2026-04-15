import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  path: string | null;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Wraps the viewer dispatch so a single misbehaving file doesn't blank the
 * whole app. Every viewer (PDF, image, mermaid, csv, docx, xlsx, …) runs
 * client-side parsing against untrusted content; a malformed file or a
 * dependency bug would otherwise hit React's uncaught-error path and
 * paint a white screen that requires a full reload.
 *
 * Reset key is the current file path, so opening a different file after
 * an error automatically re-tries.
 */
export class ViewerErrorBoundary extends Component<Props, State> {
  private lastPath: string | null;

  constructor(props: Props) {
    super(props);
    this.state = { error: null };
    this.lastPath = props.path;
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props): void {
    // Auto-reset when the user navigates to a different file.
    if (prevProps.path !== this.props.path) {
      this.lastPath = this.props.path;
      if (this.state.error) this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // biome-ignore lint/suspicious/noConsole: error boundary fallback telemetry — must survive even when UI is broken
    console.error(`Viewer crashed while rendering ${this.lastPath}:`, error, info);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex flex-1 items-center justify-center px-6" role="alert">
        <div className="max-w-md text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-signal-amber" aria-hidden="true" />
          <h2 className="mt-3 text-base font-semibold text-primary">
            This file couldn't be rendered
          </h2>
          <p className="mt-1 text-sm text-secondary">
            {this.lastPath ? (
              <>
                <code className="font-mono text-xs">{this.lastPath}</code>
                <br />
              </>
            ) : null}
            {this.state.error.message || "The viewer crashed while parsing the content."}
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="mt-4 inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs text-primary hover:bg-ironlore-slate-hover"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Try again
          </button>
        </div>
      </div>
    );
  }
}
