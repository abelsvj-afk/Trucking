"use client";

// Toast feedback (UI/UX audit F-3): the app's one success/failure
// voice. Before this there was no success feedback anywhere - saves
// were silent and Settings toggles rolled back without a word.
// Success and error are distinct by icon and shape (round check /
// square bang), not color alone. Auto-dismiss is ~4.5s; the entrance
// animation is CSS (globals.css .toast) and is neutralized by the
// global prefers-reduced-motion block like every other animation.

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastVariant = "success" | "error";

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  showToast: (message: string, variant?: ToastVariant) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const TOAST_AUTO_DISMISS_MS = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, variant: ToastVariant = "success") => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, message, variant }]);
      setTimeout(() => dismiss(id), TOAST_AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const success = useCallback((message: string) => showToast(message, "success"), [showToast]);
  const error = useCallback((message: string) => showToast(message, "error"), [showToast]);

  return (
    <ToastContext.Provider value={{ showToast, success, error }}>
      {children}
      <div className="toast-viewport" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={toast.variant === "error" ? "toast toast-error" : "toast"}
            data-variant={toast.variant}
          >
            <span
              className={
                toast.variant === "error" ? "toast-icon toast-icon-error" : "toast-icon toast-icon-success"
              }
              aria-hidden="true"
            >
              {toast.variant === "error" ? "!" : "✓"}
            </span>
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
