import React, { useEffect, useState } from "react";
import { cx } from "../api.js";

function two(n) { return String(n).padStart(2, "0"); }

/**
 * Local clock, driven by one timeout aligned to the next second boundary.
 * Purpose: the rail has no other live element; a precise clock makes "is this
 * thing polling right now" visible without adding a spinner.
 */
export default function Clock({ className }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = setTimeout(tick, 1000 - d.getMilliseconds());
    };
    timer = setTimeout(tick, 1000 - new Date().getMilliseconds());
    return () => clearTimeout(timer);
  }, []);

  return (
    <time
      className={cx("mono tnum", className)}
      dateTime={now.toISOString()}
      title={now.toLocaleString()}
    >
      {two(now.getHours())}:{two(now.getMinutes())}
      <span className="opacity-40">:{two(now.getSeconds())}</span>
    </time>
  );
}
