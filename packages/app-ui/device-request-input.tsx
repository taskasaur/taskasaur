import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";

export function DeviceRequestInput({
  value,
  label = "Device request",
}: {
  value: string;
  label?: string;
}) {
  const id = useId(),
    input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setCopied(false);
    setError("");
  }, [value]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    setError("");
    try {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        input.current?.focus();
        input.current?.select();
        if (!document.execCommand("copy")) throw new Error("Copy unavailable");
      }
      setCopied(true);
    } catch {
      setError("Select and copy the device request manually.");
    }
  }
  return (
    <div className="field-row min-w-0">
      <label htmlFor={id}>Device request</label>
      <div className="flex">
        <Input
          ref={input}
          id={id}
          aria-label={label}
          readOnly
          value={value}
          onFocus={(event) => event.target.select()}
          className="min-w-0 rounded-r-none"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="rounded-l-none border-l-0"
          aria-label="Copy device request"
          title={copied ? "Copied" : "Copy device request"}
          disabled={!value}
          onClick={() => void copy()}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <span className="sr-only" role="status">
        {copied ? "Device request copied" : ""}
      </span>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
