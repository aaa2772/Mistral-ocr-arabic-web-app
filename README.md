# Mistral OCR Arabic Web App

Arabic-friendly OCR web app for PDFs and images. The browser uploads one file to a local/server endpoint, and the server calls Mistral OCR with `MISTRAL_API_KEY` from the environment. The API key is never stored in the browser.

## Run locally

1. Create an environment file:

```sh
cp .env.example .env
```

2. Put your Mistral API key in `.env`:

```sh
MISTRAL_API_KEY=your_key_here
```

3. Start the app:

```sh
npm start
```

4. Open:

```text
http://localhost:3000
```

## Security notes

- OCR requests go through `POST /api/ocr`; the browser never receives the Mistral API key.
- The server accepts one uploaded file named `file`, with a 50MB maximum.
- Supported types: PDF, PNG, JPG/JPEG, WEBP, BMP, and TIFF.
- OCR Markdown is rendered with a small safe renderer that does not execute raw HTML.
- Recent history stores only file name, date, and page count. It does not store extracted OCR text.
- The app sets a strict Content Security Policy and self-hosts PDF.js assets.
- The server checks the uploaded file signature against the declared MIME type before calling Mistral.
- The UI uses self-hosted Dubai font files from the local `fonts/` directory, sourced from the ISC-licensed `@ahmedhamdan/dubai-font` web distribution.

## OCR options

- `pages`: optional, user-facing 1-based pages such as `1,3-5`; the server converts them to the Mistral API's 0-based page indexes.
- `tableFormat`: optional `markdown` or `html`.
- `confidence`: optional `page` or `word`.

When Mistral returns separate table or confidence metadata, the app shows it in the result details panel below the editable OCR text.

## Tests

```sh
npm test
```
