"""
config.py — Shared Configuration

All Python scraping/upload scripts read from this file.
Loads .env.local from the project root for Supabase credentials.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env.local from project root
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env.local")

# ── Supabase ──
SUPABASE_URL = os.getenv("SUPABASE_URL", os.getenv("NEXT_PUBLIC_SUPABASE_URL", ""))
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# ── Gemini (for embeddings + tags) ──
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# ── Vedabase URLs ──
VEDABASE_BASE = "https://vedabase.io/en/library"
TRANSCRIPTS_INDEX_URL = f"{VEDABASE_BASE}/transcripts/"
LETTERS_INDEX_URL = f"{VEDABASE_BASE}/letters/"

# ── Local storage paths ──
DATA_DIR = PROJECT_ROOT / "scraped_data"
TRANSCRIPTS_RAW_DIR = DATA_DIR / "transcripts" / "raw_html"
TRANSCRIPTS_JSON_DIR = DATA_DIR / "transcripts" / "json"
LETTERS_RAW_DIR = DATA_DIR / "letters" / "raw_html"
LETTERS_JSON_DIR = DATA_DIR / "letters" / "json"
EBOOKS_PDF_DIR = DATA_DIR / "ebooks" / "pdfs"
EBOOKS_JSON_DIR = DATA_DIR / "ebooks" / "json"
VALIDATION_DIR = DATA_DIR / "validation"
LOGS_DIR = DATA_DIR / "logs"

# Create all directories
for d in [TRANSCRIPTS_RAW_DIR, TRANSCRIPTS_JSON_DIR,
          LETTERS_RAW_DIR, LETTERS_JSON_DIR,
          EBOOKS_PDF_DIR, EBOOKS_JSON_DIR,
          VALIDATION_DIR, LOGS_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ── Scraping settings ──
PAGE_DELAY_SECONDS = 4          # Seconds between page loads (be polite)
RETRY_COUNT = 3                 # Retries per page on failure
BATCH_SIZE_UPLOAD = 50          # Rows per Supabase insert batch
BATCH_SIZE_EMBED = 40           # Texts per Gemini embedding call

# ── Ebooks NOT already in Supabase (identified by cross-referencing) ──
MISSING_EBOOKS = {
    # ── Official BBT publications ──
    "ejop": {
        "title": "Easy Journey to Other Planets",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Easy_Journey_to_Other_Planets.pdf",
    },
    "ekc": {
        "title": "Elevation to Kṛṣṇa Consciousness",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Elevation_to_Krishna_Consciousness.pdf",
    },
    "kcty": {
        "title": "Kṛṣṇa Consciousness: The Topmost Yoga System",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Krsna_Consciousness_Topmost_Yoga.pdf",
    },
    "lon": {
        "title": "The Laws of Nature: An Infallible Justice",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Laws_of_Nature.pdf",
    },
    "lcfl": {
        "title": "Life Comes From Life",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Life_Comes_From_Life.pdf",
    },
    "mog": {
        "title": "Message of Godhead",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Message_of_Godhead.pdf",
    },
    "mms": {
        "title": "Mukunda-mālā-stotra",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Mukunda_Mala_Stotra.pdf",
    },
    "nbs": {
        "title": "Nārada Bhakti Sūtra",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Narada_Bhakti_Sutra.pdf",
    },
    "rtw": {
        "title": "Renunciation Through Wisdom",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Renunciation_through_wisdom.pdf",
    },
    "top": {
        "title": "Transcendental Teachings of Prahlāda Mahārāja",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Teachings_of_Prahlada.pdf",
    },
    # ── Prabhupāda's early works and compositions ──
    "snb": {
        "title": "Sannyāsa Book",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/09/Prabhupada_Sannyasa_book.pdf",
    },
    "va": {
        "title": "Vaiśiṣṭya Aṣṭaka",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/09/Prabhupada_Vaisistya_astaka.pdf",
    },
    "vra1": {
        "title": "Viraha Aṣṭaka",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/09/Prabhupada_Viraha_astaka.pdf",
    },
    "vra2": {
        "title": "Viraha Aṣṭaka (2)",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/09/Prabhupada_Viraha_astaka2.pdf",
    },
    "amns": {
        "title": "Āmnāya Sūtra",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Amnayasutra.pdf",
    },
    # ── Works with Prabhupāda's commentary on previous ācāryas ──
    "ksand": {
        "title": "Kṛṣṇa Sandarbha",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Krsna_Sandarbha.pdf",
    },
    "lbhag": {
        "title": "Laghu-bhāgavatāmṛta",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_LaghuBhagOne.pdf",
    },
    "tviv": {
        "title": "Tattva-viveka",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Tattva-Viveka.pdf",
    },
    # ── Compilations of Prabhupāda's teachings ──
    "nbd": {
        "title": "Nectar of Book Distribution",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Nectar_of_Book_Distribution.pdf",
    },
    "sfcsl": {
        "title": "Standards for Cooking for the Supreme Lord",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Standards_for_cooking_for_the_Supreme_Lord-v1.2.pdf",
    },
    # ── Songbook ──
    "vsb": {
        "title": "Vaiṣṇava Songbook",
        "url": "http://gaudiyahistory.iskcondesiretree.com/wp-content/uploads/2011/10/Prabhupada_Vaishnava_Songbook.pdf",
    },
}
