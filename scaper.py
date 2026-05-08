import feedparser
import html
from datetime import datetime

def fetch_news_from_rss(url, source_name):
    try:
        feed = feedparser.parse(url)
        articles = []
        for entry in feed.entries[:5]:
            articles.append({
                'title': html.unescape(entry.title),
                'link': entry.link,
                'source': source_name
            })
        return articles
    except Exception as e:
        print(f"Failed to fetch {source_name}: {e}")
        return []

def generate_html(news_data):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC")
    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Global News Aggregator - {timestamp}</title>
    <style>body {{ font-family: Arial; margin: 20px; }} .article {{ margin-bottom: 10px; }}</style></head>
    <body><h1>News</h1><h2>Time: {timestamp}</h2>
    """
    for source_name, articles in news_data.items():
        html_content += f"<h3>{source_name}</h3><ul>"
        for article in articles:
            html_content += f'<li><a href="{article["link"]}">{html.escape(article["title"])}</a></li>'
        html_content += "</ul>"
    html_content += "</body></html>"
    return html_content

if __name__ == "__main__":
    SOURCES = {
        "Fox News": "https://moxie.foxnews.com/google-publisher/latest.xml",
        "ABC News": "http://abcnews.go.com/abcnews/topstories",
        "CBS News": "https://www.cbsnews.com/latest/rss/main",
        "The Jerusalem Post": "https://www.jpost.com/Rss/RssFeedsHeadlines.aspx",
        # "Axios": "https://www.axios.com/feed.xml",
    }
    all_news = {}
    for source_name, rss_url in SOURCES.items():
        print(f"Fetching {source_name}...")
        news_items = fetch_news_from_rss(rss_url, source_name)
        if news_items:
            all_news[source_name] = news_items
    html_output = generate_html(all_news)
    with open("output/index.html", "w", encoding="utf-8") as f:
        f.write(html_output)
