import feedparser
import html
import requests
import time
import random
import json
import os
from datetime import datetime
from typing import List, Dict, Optional, Tuple
from urllib.parse import urlparse
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class RobustNewsScraper:
    
    def __init__(self):
        self.user_agents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
        ]
        self.timeout = 15
        self.max_retries = 3
        self.delay_between_requests = 1
        
    def get_session(self) -> requests.Session:
        session = requests.Session()
        session.headers.update({
            'User-Agent': random.choice(self.user_agents),
            'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache'
        })
        return session
    
    def fetch_rss_with_retry(self, url: str, source_name: str) -> Optional[feedparser.FeedParserDict]:
        for attempt in range(self.max_retries):
            try:
                session = self.get_session()
                response = session.get(url, timeout=self.timeout)
                response.raise_for_status()
                
                feed = feedparser.parse(response.content)
                
                if feed.bozo:
                    logger.warning(f"Feed parsing warning for {source_name}: {feed.bozo_exception}")
                    if not feed.entries:
                        raise Exception("No entries found in feed")
                
                time.sleep(self.delay_between_requests)
                return feed
                
            except requests.Timeout:
                logger.warning(f"Timeout for {source_name} (attempt {attempt + 1}/{self.max_retries})")
                time.sleep(2 ** attempt)
                
            except requests.ConnectionError:
                logger.warning(f"Connection error for {source_name} (attempt {attempt + 1}/{self.max_retries})")
                time.sleep(3)
                
            except Exception as e:
                logger.error(f"Unexpected error for {source_name}: {str(e)}")
                if attempt == self.max_retries - 1:
                    return None
                time.sleep(2)
                
        return None
    
    def extract_articles_safely(self, feed, source_name: str, max_articles: int = 5) -> List[Dict]:
        articles = []
        
        if not feed or not hasattr(feed, 'entries'):
            logger.warning(f"No entries found in feed for {source_name}")
            return []
        
        for idx, entry in enumerate(feed.entries[:max_articles]):
            try:
                title = "No Title"
                if hasattr(entry, 'title') and entry.title:
                    title = html.unescape(str(entry.title)[:200])  # محدودیت طول
                
                link = "#"
                if hasattr(entry, 'link') and entry.link:
                    link = str(entry.link)
                elif hasattr(entry, 'id') and entry.id:
                    link = str(entry.id)
                
                summary = ""
                if hasattr(entry, 'summary') and entry.summary:
                    summary = html.unescape(str(entry.summary)[:300])
                elif hasattr(entry, 'description') and entry.description:
                    summary = html.unescape(str(entry.description)[:300])
                
                articles.append({
                    'title': title,
                    'link': link,
                    'summary': summary,
                    'source': source_name,
                    'timestamp': datetime.now().isoformat()
                })
                
            except Exception as e:
                logger.error(f"Error extracting article {idx} from {source_name}: {str(e)}")
                continue
                
        return articles
    
    def get_local_backup(self, source_name: str) -> List[Dict]:
        backup_file = f"backups/{source_name}.json"
        
        if os.path.exists(backup_file):
            try:
                with open(backup_file, 'r', encoding='utf-8') as f:
                    backup_data = json.load(f)
                    logger.info(f"Loaded backup for {source_name} with {len(backup_data)} articles")
                    return backup_data
            except Exception as e:
                logger.error(f"Failed to load backup for {source_name}: {str(e)}")
        
        return [{
            'title': f"Unable to fetch news from {source_name} - Service temporarily unavailable",
            'link': '#',
            'summary': 'Please try again later',
            'source': source_name,
            'timestamp': datetime.now().isoformat()
        }]
    
    def save_backup(self, source_name: str, articles: List[Dict]):
        try:
            os.makedirs('backups', exist_ok=True)
            backup_file = f"backups/{source_name}.json"
            
            with open(backup_file, 'w', encoding='utf-8') as f:
                json.dump(articles, f, ensure_ascii=False, indent=2)
                
        except Exception as e:
            logger.error(f"Failed to save backup for {source_name}: {str(e)}")
    
    def fetch_with_fallback(self, source_name: str, rss_url: str) -> List[Dict]:
        
        logger.info(f"Fetching {source_name} from {rss_url}")
        feed = self.fetch_rss_with_retry(rss_url, source_name)
        
        if feed:
            articles = self.extract_articles_safely(feed, source_name)
            if articles:
                self.save_backup(source_name, articles)
                return articles
        
        logger.warning(f"Using backup for {source_name}")
        return self.get_local_backup(source_name)


class MHTMLBuilder:
    
    def __init__(self):
        self.max_retries = 2
        
    def generate_html(self, all_news: Dict[str, List[Dict]]) -> str:
        try:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S UTC")
            
            total_sources = len(all_news)
            successful_sources = sum(1 for articles in all_news.values() if articles)
            
            html_parts = [
                '<!DOCTYPE html>',
                '<html lang="en">',
                '<head>',
                '<meta charset="UTF-8">',
                '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
                f'<title>Global News Aggregator - {timestamp}</title>',
                '<style>',
                'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }',
                '.container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); overflow: hidden; }',
                '.header { background: #1a1a2e; color: white; padding: 20px; text-align: center; }',
                '.stats { background: #e0e0e0; padding: 10px 20px; font-size: 14px; color: #333; }',
                '.news-section { padding: 20px; border-bottom: 1px solid #eee; }',
                '.news-section h2 { color: #1a1a2e; margin-top: 0; padding-bottom: 10px; border-bottom: 2px solid #007bff; }',
                '.article { margin: 15px 0; padding: 10px; background: #fafafa; border-radius: 4px; }',
                '.article h3 { margin: 0 0 5px 0; font-size: 16px; }',
                '.article a { color: #007bff; text-decoration: none; }',
                '.article a:hover { text-decoration: underline; }',
                '.summary { font-size: 14px; color: #666; margin: 5px 0 0 0; }',
                '.error-badge { background: #dc3545; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; display: inline-block; }',
                '@media (max-width: 768px) { body { padding: 10px; } .news-section { padding: 10px; } }',
                '</style>',
                '</head>',
                '<body>',
                '<div class="container">',
                f'<div class="header"><h1>📰 Global News Monitor</h1><p>Last Updated: {timestamp}</p></div>',
                f'<div class="stats">✅ Successfully loaded: {successful_sources}/{total_sources} sources | 🔄 Auto-updates every 30 minutes</div>'
            ]
            
            for source_name, articles in all_news.items():
                html_parts.append(f'<div class="news-section"><h2>📌 {source_name}</h2>')
                
                if not articles:
                    html_parts.append('<div class="article"><span class="error-badge">⚠️ No data available</span><p>Could not fetch news from this source. Will retry in next update.</p></div>')
                else:
                    for article in articles:
                        html_parts.append(f'''
                        <div class="article">
                            <h3><a href="{article.get('link', '#')}" target="_blank">{self._escape_html(article.get('title', 'No Title'))}</a></h3>
                            {f'<p class="summary">{self._escape_html(article.get("summary", ""))}</p>' if article.get('summary') else ''}
                            <small>📅 {article.get('timestamp', 'Unknown time')}</small>
                        </div>
                        ''')
                
                html_parts.append('</div>')
            
            html_parts.extend([
                '<div style="text-align: center; padding: 20px; background: #f8f9fa; color: #666; font-size: 12px;">',
                'Generated by GitHub Actions | Data fetched from official RSS feeds',
                '</div></div></body></html>'
            ])
            
            return '\n'.join(html_parts)
            
        except Exception as e:
            logger.error(f"Fatal error generating HTML: {str(e)}")
            return f'''
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>Error - News Aggregator</title></head>
            <body>
            <h1>⚠️ Error Generating Page</h1>
            <p>An error occurred: {str(e)}</p>
            <p>Please check the workflow logs for details.</p>
            </body>
            </html>
            '''
    
    def _escape_html(self, text: str) -> str:
        try:
            return html.escape(str(text))[:500]
        except:
            return "Invalid content"
    
    def save_as_mhtml(self, html_path: str, mhtml_path: str) -> bool:
        
        methods = [
            self._save_simple_mhtml,
            self._save_as_html_fallback
        ]
        
        for method in methods:
            try:
                if method(html_path, mhtml_path):
                    logger.info(f"Successfully saved MHTML using {method.__name__}")
                    return True
            except Exception as e:
                logger.warning(f"Method {method.__name__} failed: {str(e)}")
                continue
        
        return False
    
    def _save_simple_mhtml(self, html_path: str, mhtml_path: str) -> bool:
        try:
            boundary = f"boundary_{int(time.time())}"
            
            with open(mhtml_path, 'w', encoding='utf-8') as mhtml_file:
                mhtml_file.write(f"From: GitHub Actions\r\n")
                mhtml_file.write(f"Subject: News Aggregator Report\r\n")
                mhtml_file.write(f"Date: {datetime.now().strftime('%a, %d %b %Y %H:%M:%S +0000')}\r\n")
                mhtml_file.write(f"MIME-Version: 1.0\r\n")
                mhtml_file.write(f"Content-Type: multipart/related; type=\"text/html\"; boundary=\"{boundary}\"\r\n\r\n")
                mhtml_file.write(f"--{boundary}\r\n")
                
                with open(html_path, 'r', encoding='utf-8') as html_file:
                    html_content = html_file.read()
                
                mhtml_file.write(f"Content-Type: text/html; charset=\"utf-8\"\r\n")
                mhtml_file.write(f"Content-Transfer-Encoding: 8bit\r\n")
                mhtml_file.write(f"Content-Location: main.html\r\n\r\n")
                mhtml_file.write(html_content)
                mhtml_file.write(f"\r\n--{boundary}--\r\n")
            
            return os.path.exists(mhtml_path) and os.path.getsize(mhtml_path) > 0
            
        except Exception as e:
            logger.error(f"Simple MHTML save failed: {str(e)}")
            return False
    
    def _save_as_html_fallback(self, html_path: str, mhtml_path: str) -> bool:
        try:
            import shutil
            shutil.copy2(html_path, mhtml_path)
            logger.warning(f"Saved as HTML fallback (not true MHTML) to {mhtml_path}")
            return True
        except Exception as e:
            logger.error(f"Fallback save failed: {str(e)}")
            return False


def main():
    
    SOURCES = {
        "Fox News": [
            "https://moxie.foxnews.com/google-publisher/latest.xml",
            "https://feeds.foxnews.com/foxnews/latest"  # backup URL
        ],
        "ABC News": [
            "http://abcnews.go.com/abcnews/topstories",
            "https://abcnews.go.com/abcnews/topstories?format=rss"
        ],
        "CBS News": [
            "https://www.cbsnews.com/latest/rss/main",
            "https://www.cbsnews.com/feeds/rss/main"
        ],
        "The Jerusalem Post": [
            "https://www.jpost.com/Rss/RssFeedsHeadlines.aspx",
            "https://www.jpost.com/rss/rssfeedsheadlines.aspx"
        ],
        "Axios": [
            "https://www.axios.com/feed.xml",
            "https://rss.app/feeds/axios-news.xml"
        ]
    }
    
    scraper = RobustNewsScraper()
    builder = MHTMLBuilder()
    
    all_news = {}
    
    for source_name, urls in SOURCES.items():
        articles = []
        
        for url in urls:
            articles = scraper.fetch_with_fallback(source_name, url)
            if articles and len(articles) >= 3:
                break
        
        all_news[source_name] = articles if articles else []
        
        time.sleep(1)
    
    try:
        html_content = builder.generate_html(all_news)
        
        os.makedirs('output', exist_ok=True)
        
        html_path = "output/index.html"
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write(html_content)
        
        mhtml_path = "output/news.mhtml"
        success = builder.save_as_mhtml(html_path, mhtml_path)
        
        if success:
            logger.info("✅ News aggregation completed successfully")
        else:
            logger.error("❌ Failed to create MHTML file, but HTML is available")
            
        with open("output/status.json", 'w', encoding='utf-8') as f:
            json.dump({
                "timestamp": datetime.now().isoformat(),
                "sources_processed": len(all_news),
                "sources_with_data": sum(1 for v in all_news.values() if v),
                "success": success
            }, f, indent=2)
            
    except Exception as e:
        logger.error(f"Fatal error in main: {str(e)}")
        with open("output/news.mhtml", 'w', encoding='utf-8') as f:
            f.write(f"<html><body><h1>Error</h1><p>{str(e)}</p></body></html>")


if __name__ == "__main__":
    main()
