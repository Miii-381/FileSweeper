import { useCallback, useEffect, useRef, useState } from "react";

export function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  const timeout = useRef<number | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (timeout.current) window.clearTimeout(timeout.current);
    timeout.current = window.setTimeout(() => setToast(null), 3600);
  }, []);
  useEffect(() => () => {
    if (timeout.current) window.clearTimeout(timeout.current);
  }, []);
  return { toast, notify };
}
