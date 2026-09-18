import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './ui';

interface Props {
  children: ReactNode;
  name?: string;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`ErrorBoundary caught error in ${this.props.name || 'component'}:`, error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  public override render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="flex h-full flex-col items-center justify-center p-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
            <AlertTriangle size={24} />
          </div>
          <h3 className="mt-3 font-semibold text-ink">
            {this.props.name ? `${this.props.name} encountered an error` : 'Something went wrong'}
          </h3>
          <p className="mt-1 max-w-md text-[12.5px] text-faint">
            {this.state.error?.message || 'An unexpected error occurred while rendering this screen.'}
          </p>
          <Button size="sm" variant="ghost" onClick={this.handleReset} className="mt-4">
            <RefreshCw size={13} /> Try again
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
