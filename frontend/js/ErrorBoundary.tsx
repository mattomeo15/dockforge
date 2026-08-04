import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  declare props: Props;
  declare state: State;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Unhandled UI error caught by ErrorBoundary:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-900 text-slate-100 p-6 font-sans">
          <div className="max-w-md w-full bg-slate-800 border border-red-500/30 rounded-xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center space-x-3 text-red-400">
              <i className="fa-solid fa-triangle-exclamation text-2xl"></i>
              <h2 className="text-lg font-bold text-white">Application Error Caught</h2>
            </div>
            <p className="text-sm text-slate-300">
              DockForge encountered an unhandled error while rendering the interface.
            </p>
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-700 font-mono text-xs text-red-300 overflow-x-auto max-h-40">
              {this.state.error?.message || 'Unknown application error'}
            </div>
            <button
              onClick={() => window.location.reload()}
              className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs rounded-lg transition shadow-sm"
            >
              <i className="fa-solid fa-rotate-right mr-1.5"></i> Reload App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
