#!/usr/bin/env python3
"""Read-only TrendBoss TESTNET watcher. Healthy polling is intentionally silent."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HEALTH_URL = os.environ.get("TRENDBOSS_HEALTH_URL", "http://localhost:8787/health")
EVENT_PATH = Path(os.environ.get("TRENDBOSS_EVENT_LOG", "logs/events.TESTNET.jsonl"))
POLL_SECONDS = float(os.environ.get("TRENDBOSS_WATCHDOG_SECONDS", "15"))


class Watchdog:
    def __init__(self) -> None:
        self.last_event_id = int(os.environ.get("HERMES_LAST_EVENT_ID", "0"))
        self.events_primed = self.last_event_id > 0
        self.last_health_alert: str | None = None

    def poll(self) -> None:
        health_alert = self.health_alert()
        if health_alert != self.last_health_alert:
            if health_alert:
                print(health_alert, flush=True)
            self.last_health_alert = health_alert
        for alert in self.event_alerts():
            print(alert, flush=True)

    def health_alert(self) -> str | None:
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=5) as response:
                health = json.load(response)
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            return f"TrendBoss alert: service down ({exc})"

        if health.get("mode") != "TESTNET":
            return f"TrendBoss alert: wrong mode {health.get('mode')}"
        process_count = int(health.get("traderProcessCount", 0))
        if process_count > 1:
            return f"TrendBoss alert: duplicate trader processes ({process_count})"
        if not health.get("traderRunning"):
            return "TrendBoss alert: trader service down"
        heartbeat_age = health.get("heartbeatAgeSec")
        if heartbeat_age is None or heartbeat_age > 135 or health.get("feedSocketStatus") == "STALE":
            return f"TrendBoss alert: stale heartbeat/feed ({heartbeat_age}s)"
        return None

    def event_alerts(self) -> list[str]:
        if not EVENT_PATH.exists():
            self.events_primed = True
            return []
        try:
            events = []
            for line in EVENT_PATH.read_text(encoding="utf-8").splitlines():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                event_id = int(event.get("eventId", 0))
                if event_id > self.last_event_id:
                    events.append(event)
        except OSError:
            return []

        if not self.events_primed:
            self.last_event_id = max((int(event.get("eventId", 0)) for event in events), default=0)
            self.events_primed = True
            return []

        alerts = []
        for event in events:
            self.last_event_id = max(self.last_event_id, int(event.get("eventId", 0)))
            event_type = event.get("type") or event.get("event")
            if event_type in {"OPEN", "CLOSE", "ERROR"}:
                symbol = event.get("symbol") or "system"
                detail = event.get("reason") or event.get("error") or event.get("status")
                alerts.append(f"TrendBoss {event_type}: {symbol} {detail}")
        return alerts


def main() -> None:
    watchdog = Watchdog()
    once = "--once" in sys.argv
    while True:
        watchdog.poll()
        if once:
            return
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
