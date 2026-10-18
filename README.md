# M_news

A self-contained news reader for Windows. No installation, no dependencies. Download, double-click, read.

## Download

Go to the [**latest release**](../../releases/latest) and download `start.exe`.

That's it. Double-click it and the reader opens.

**Requirements:** Windows 10 (build 19041+) or Windows 11.

## What it does

- Collects news from Persian, Hebrew, Israeli, and US sources
- Translates non-Persian articles to Persian automatically
- Downloads images locally
- Keeps a rolling archive of the last 500 stories
- Refreshes itself every 5 minutes in the background

The news is fetched and translated on GitHub Actions every 2 hours and committed to `output/`. The desktop app pulls the latest data from GitHub when it starts and when you press **Refresh**.

## Sources

- BBC Persian
- DW Farsi
- Iran International
- C14
- Ynetnews
- Times of Israel
- Al Jazeera
- RFE/RL
- Reza Pahlavi
- Fox News
- New York Post
- Washington Times
- National Review
- The Daily Caller

## Development

```bash
npm install          # Node dependencies for the scraper
pip install pywebview  # Optional, native window on Linux

npm run a            # fetch + translate locally
python3 start.py     # run the reader (native window)
python3 start.py --browser  # open in browser instead
```

The build runs automatically on push to `main` when frontend files change. Each build creates a new tagged release.

## License

MIT