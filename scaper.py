import sys
import os
import json
from datetime import datetime

print("=" * 50)
print("News Scraper Started")
print(f"Python version: {sys.version}")
print(f"Current directory: {os.getcwd()}")
print(f"Files in current directory: {os.listdir('.')}")
print("=" * 50)

SAMPLE_NEWS = {
    "Fox News": [
        {"title": "Test News 1", "link": "https://example.com/1", "source": "Fox News"},
        {"title": "Test News 2", "link": "https://example.com/2", "source": "Fox News"},
    ],
    "ABC News": [
        {"title": "Test News A", "link": "https://example.com/a", "source": "ABC News"},
        {"title": "Test News B", "link": "https://example.com/b", "source": "ABC News"},
    ]
}

def generate_html(news_data):
    """ساخت فایل HTML ساده"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>News Aggregator - {timestamp}</title>
    <style>
        body {{ font-family: Arial, sans-serif; margin: 20px; background: #f0f0f0; }}
        .container {{ max-width: 800px; margin: auto; background: white; padding: 20px; border-radius: 10px; }}
        h1 {{ color: #333; }}
        .news-item {{ margin: 15px 0; padding: 10px; border-left: 3px solid #007bff; background: #f9f9f9; }}
        .source {{ color: #007bff; font-weight: bold; }}
        .timestamp {{ color: #999; font-size: 12px; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>📰 Global News Monitor</h1>
        <p class="timestamp">Last updated: {timestamp}</p>
        <p>✅ Successfully loaded news from {len(news_data)} sources</p>
"""
    
    for source, articles in news_data.items():
        html += f'<h2>{source}</h2>'
        for article in articles:
            html += f'''
            <div class="news-item">
                <a href="{article['link']}" target="_blank">{article['title']}</a>
                <div class="source">{article['source']}</div>
            </div>
            '''
    
    html += """
    </div>
</body>
</html>
"""
    return html

def main():
    print("Generating news HTML...")
    
    os.makedirs("output", exist_ok=True)
    os.makedirs("backups", exist_ok=True)
    
    html_content = generate_html(SAMPLE_NEWS)
    
    html_path = "output/index.html"
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)
    print(f"✅ HTML saved to {html_path}")
    print(f"File size: {os.path.getsize(html_path)} bytes")
    
    mhtml_path = "output/news.mhtml"
    boundary = f"boundary_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    with open(mhtml_path, "w", encoding="utf-8") as f:
        f.write(f"From: GitHub Actions\r\n")
        f.write(f"Subject: News Report\r\n")
        f.write(f"Date: {datetime.now().strftime('%a, %d %b %Y %H:%M:%S +0000')}\r\n")
        f.write(f"MIME-Version: 1.0\r\n")
        f.write(f"Content-Type: multipart/related; type=\"text/html\"; boundary=\"{boundary}\"\r\n\r\n")
        f.write(f"--{boundary}\r\n")
        f.write(f"Content-Type: text/html; charset=\"utf-8\"\r\n")
        f.write(f"Content-Transfer-Encoding: 8bit\r\n")
        f.write(f"Content-Location: main.html\r\n\r\n")
        f.write(html_content)
        f.write(f"\r\n--{boundary}--\r\n")
    
    print(f"✅ MHTML saved to {mhtml_path}")
    print(f"File size: {os.path.getsize(mhtml_path)} bytes")
    
    status = {
        "timestamp": datetime.now().isoformat(),
        "sources": len(SAMPLE_NEWS),
        "status": "success"
    }
    
    with open("output/status.json", "w", encoding="utf-8") as f:
        json.dump(status, f, indent=2)
    
    print("=" * 50)
    print("✅ Script completed successfully!")
    print("=" * 50)
    
    return 0

if __name__ == "__main__":
    try:
        exit_code = main()
        sys.exit(exit_code)
    except Exception as e:
        print(f"❌ Fatal error: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
