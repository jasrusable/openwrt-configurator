// A command's output, kept scrolled to the newest line while it grows.
import { Code, ScrollArea } from "@mantine/core";
import { useEffect, useRef } from "react";

export const LogView = ({ text, height = 320 }: { text: string; height?: number }) => {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [text]);
  return (
    <ScrollArea h={height} viewportRef={viewport}>
      <Code block style={{ whiteSpace: "pre-wrap", minHeight: height }}>
        {text || "No output yet."}
      </Code>
    </ScrollArea>
  );
};
