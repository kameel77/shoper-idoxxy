# Shoper ↔ Idoxxy Integration (Node.js)

Wtyczka serwerowa w Node.js, której zadaniem jest integracja sklepu Shoper z platformą Idoxxy (trwały nośnik). Projekt stanowi fundament pod rozwój pełnej aplikacji konfiguracyjnej i webhooków obsługujących automatyczne dostarczanie dokumentów.

## Funkcjonalności (wersja wstępna)

- Serwer Express z TypeScriptem i middleware bezpieczeństwa (`helmet`, `morgan`).
- Statyczna strona startowa (`/`) z opisem integracji oraz panel ustawień (`/settings`) do dalszej rozbudowy.
- Moduł komunikacji z API Idoxxy:
  - Autoryzacja OAuth2 (client credentials) + nagłówek `X-API-KEY`.
  - Endpoint diagnostyczny `/settings/test-connection`, który wykorzystuje `GET /details/me`.
- Token-first linking (per sklep Shoper):
  - UI w `/settings` do wklejenia tokena Idoxxy, testu przez `/details/me` i zapisu powiązania shop→workspace/token.
  - Endpointy: `/settings/link/test`, `/settings/link`, `/settings/link/status/:shopId`, `/settings/link/connections`.
  - Webhooki pracują w kontekście sklepu (nagłówek `X-Shoper-Shop-Id` / `X-Shop-Id` / `X-Shop` / `X-Shop-Url` lub `shop_id` w payloadzie); brak linku → 428 + log z błędem.
- Warstwa konfiguracji (in-memory):
  - Zapisywanie poświadczeń API, domyślnych grup oraz mapowań zdarzeń.
  - Walidacja danych przy pomocy Zod.
- Przygotowana struktura projektu: moduły `clients`, `services`, `repositories`, `routes`, `types`, `public`.

## Wymagania

- Node.js ≥ 18
- npm

## Instalacja i uruchomienie

```bash
npm install
npm run build
npm run dev        # development (ts-node)
# lub
npm start          # po zbudowaniu (dist/)
```

Domyślnie serwer nasłuchuje na porcie `3000` (zmień poprzez zmienną `PORT`).

## Zmienne środowiskowe

Konfiguracja w `src/config/env.ts` (Zod). Ustaw w pliku `.env`:

```ini
PORT=3000
IDOXXY_API_KEY=...
IDOXXY_CLIENT_ID=...
IDOXXY_CLIENT_SECRET=...
IDOXXY_BASE_URL=https://api.idoxxy.com
SHOPER_CLIENT_ID=...
SHOPER_CLIENT_SECRET=...
SHOPER_BASE_URL=https://twoj-sklep.shoper.pl/webapi/rest
```

Bez podanych wartości endpoint testowy zwróci błąd informujący o brakujących poświadczeniach.

## Dostępne endpointy

| Metoda | Ścieżka                      | Opis |
| ------ | --------------------------- | ---- |
| GET    | `/`                         | Strona startowa (statyczny opis integracji). |
| GET    | `/settings`                 | Panel konfiguracji (placeholder). |
| GET    | `/settings/test-connection` | Test połączenia z Idoxxy (`/details/me`). |
| GET    | `/settings/test-shoper`     | Test połączenia z Shoper (`GET /webapi/rest/shops`). |
| POST   | `/settings/link/test`       | Test tokena Idoxxy dla sklepu (wymaga `shopId`, `token`). |
| POST   | `/settings/link`            | Zapis mapowania sklepu na workspace/token. |
| GET    | `/settings/link/status/:shopId` | Status połączenia sklepu. |
| GET    | `/settings/link/connections` | Lista powiązanych sklepów. |
| GET    | `/settings/config`          | Zrzut aktualnych ustawień (in-memory). |
| PUT    | `/settings/credentials`     | Zapis poświadczeń API. |
| PUT    | `/settings/default-groups`  | Aktualizacja domyślnych grup. |
| POST   | `/settings/mappings`        | Dodanie/aktualizacja mapowania zdarzenia. |
| DELETE | `/settings/mappings/:id`    | Usunięcie mapowania. |

Webhooki wymagają identyfikatora sklepu (`X-Shoper-Shop-Id` / `X-Shop-Id` / `X-Shop` / `X-Shop-Url` lub `shop_id` w payloadzie); na tej podstawie wybierany jest token zapisany podczas linkowania. Brak aktywnego powiązania → kod 428 oraz log błędu.

## Struktura katalogów

```
src/
  app.ts                # konfiguracja Express
  index.ts              # punkt startowy serwera
  config/env.ts         # walidacja zmiennych środowiskowych
  clients/idoxxyClient  # klient HTTP z obsługą OAuth2
  services/idoxxyService# logika pomocnicza dla API Idoxxy
  repositories/         # przechowywanie konfiguracji (na razie in-memory)
  routes/settings.ts    # REST API dla ustawień
  types/                # typy domenowe (mapowania, poświadczenia)
public/
  index.html            # landing z menu
  settings.html         # placeholder panelu
```

## Następne kroki (propozycje)

1. Dodać rzeczywiste formularze SPA (np. React/Vue) korzystające z istniejących endpointów.
2. Zastąpić in-memory storage trwałym magazynem (SQLite/PostgreSQL).
3. Obsłużyć webhooki / eventy Shopera i powiązać je z mapowaniami.
4. Rozbudować logowanie, retry oraz monitoring awarii integracji.

## Licencja

MIT (do uzupełnienia według potrzeb projektu).
