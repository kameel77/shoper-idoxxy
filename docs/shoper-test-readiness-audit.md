# Audyt gotowości aplikacji do oddania na testy Shoper.pl

Data audytu: 2026-03-25

## 1) Zakres i źródła

Przeanalizowano:

1. Publiczne materiały Shoper Learn powiązane z sekcją Developers/App Store (w tym aktualizacja i workflow publikacji aplikacji).
2. Kod repozytorium `shoper-idoxxy` (backend, trasy, konfiguracja, UI statyczne i skrypty).

> Uwaga: strona `https://developers.shoper.pl/developers` jest aktualnie renderowana w sposób, który utrudnia automatyczny odczyt pełnej treści w narzędziu CLI (widoczne głównie menu i stopka). Dlatego wymagania operacyjne zweryfikowano przez powiązane artykuły Shoper Learn odsyłające do Developers/App Store.

## 2) Najważniejsze wymagania procesu po stronie Shoper (z dokumentacji)

### 2.1 Publikacja aplikacji do weryfikacji

Z artykułu „Warianty aplikacji w Shoper App Store” (aktualizacja: 19 marca 2026) wynika, że przy publikacji do weryfikacji wymagane są co najmniej:

- przejście przez etap **„Publikuj do weryfikacji”**,
- obowiązkowy **opis aplikacji**,
- obowiązkowy **adres e-mail kontaktowy**,
- konfiguracja sekcji **Cennik** i pakietów cennikowych (dla modeli okresowych).

### 2.2 Integracja API i uprawnienia

Z artykułu „Generowanie tokena API dla integracji zewnętrznej” (aktualizacja: 20 marca 2025):

- dla nowych połączeń sugerowany jest model oparty o **Token API**,
- podczas tworzenia integracji definiuje się **obszary uprawnień** i **zakres dostępu**,
- można wskazywać obszary m.in. Klienci, Zamówienia, Webhooki itp.

### 2.3 Webhooki

Z artykułu „Jak utworzyć webhook?” (aktualizacja: 19 sierpnia 2024):

- webhook wymaga: URL odbiorcy, opcjonalnego klucza i wyboru zdarzeń,
- po stronie odbiorcy powinien istnieć skrypt/endpoint obsługujący request,
- rekomendowana jest weryfikacja autentyczności (suma kontrolna/podpis),
- sugerowane jest TLS/SSL.

## 3) Stan bieżący aplikacji (kod)

## 3.1 Co jest już dobrze przygotowane

- Istnieją endpointy webhook dla `customer-created` i `order-created` oraz walidacja payloadu Zod.
- Jest weryfikacja podpisu webhooka oparta o HMAC SHA-256 (`SHOPER_WEBHOOK_SECRET`) + `timingSafeEqual`.
- Jest mechanizm kontekstu sklepu (shopId z nagłówków/query/body).
- Jest panel ustawień i linkowania sklepu z iDoxxy.
- Utrwalanie konfiguracji i połączeń działa na SQLite.

## 3.2 Kluczowe braki blokujące oddanie do testów marketplace

### A. Brak kompletnego, automatycznego flow instalacji aplikacji z App Store

Obecnie projekt bazuje na ręcznym podaniu `shopId`/tokena i ręcznym „linkowaniu” (`/settings/link`, `/settings/link/test`). Brakuje pełnego cyklu marketplace-ready:

1. handshake/instalacja po stronie App Store,
2. automatyczne utworzenie/aktualizacja połączenia sklepu po instalacji,
3. obsługa deinstalacji/odpięcia aplikacji (cleanup, statusy, revocation flow).

### B. Brak jawnej matrycy uprawnień wymaganych przez aplikację

Dokumentacja Shoper wymaga świadomego doboru obszarów i zakresów API. W repo brak zdefiniowanego artefaktu „minimalne uprawnienia aplikacji” (np. matrix: resource → scope → uzasadnienie biznesowe), co zwykle jest wymagane na etapie testów/review.

### C. Brak kompletnego pakietu metadanych publikacyjnych i zgodności

Kod nie zawiera technicznie przygotowanego „pakietu do review”, tj.:

- opis aplikacji pod listing (PL, skrócony + pełny),
- e-mail supportowy i procedura SLA,
- polityka prywatności / regulamin / podstawa przetwarzania danych,
- instrukcja instalacji i konfiguracji krok-po-kroku dla testera,
- materiał „known limitations” i scenariusze testowe.

### D. Niespójność bezpieczeństwa podpisu webhook vs starszy model Shoper

W dokumentacji historycznej webhooków pojawia się model SHA1 oparty o `X-WEBHOOK-*`, a w kodzie wdrożony jest HMAC SHA-256 pod `X-Shoper-Webhook-Signature`/`X-Shoper-Signature`.

To może być poprawne dla nowszego modelu, ale przed oddaniem do testów trzeba mieć jednoznacznie potwierdzone (w aktualnej dokumentacji Developers), jakie nagłówki i algorytm są wymagane przez środowisko testowe, oraz dodać fallback/kompatybilność jeśli testy Shoper tego wymagają.

### E. Brak gotowości jakościowej (CI) – projekt nie przechodzi kompilacji TypeScript

`npm run build` kończy się błędami typów (`string | string[]` vs `string`) w wielu trasach. To jest blocker do testów integracyjnych i publikacji.

### F. Brak testów automatycznych i lintingu jakościowego

- `npm run test` jest stubem i celowo kończy się błędem,
- `npm run lint` jest stubem (brak realnej walidacji stylu/jakości).

W praktyce review marketplace zwykle oczekuje powtarzalnej jakości i regresji.

### G. Ryzyko bezpieczeństwa sesji w produkcji

`SESSION_SECRET` ma domyślną wartość fallbackową; jeśli nie zostanie nadpisana w środowisku testowym/produkcyjnym, bezpieczeństwo sesji jest niewystarczające.

### H. Rozbieżność dokumentacji projektu vs rzeczywisty stan

`app_description.md` deklaruje m.in. CORS protection i rate limiting, których realnie nie widać w middleware aplikacji. Taka rozbieżność podczas testów/review obniża wiarygodność i utrudnia akceptację.

## 4) Rekomendowany plan domknięcia przed wysyłką do testów Shoper

## Etap 1 — Must-have (blokery)

1. Naprawić błędy TypeScript tak, aby `npm run build` przechodził bez błędów.
2. Dodać realne testy (minimum smoke + webhook signature + mapping + error handling).
3. Dodać lint + format check (np. ESLint + Prettier) i pipeline CI.

## Etap 2 — Wymagania integracyjne Shoper

4. Domknąć i udokumentować flow instalacji/deinstalacji aplikacji z App Store.
5. Przygotować jawny dokument uprawnień API (resource/scope/rationale).
6. Zweryfikować (na aktualnym Developers) model podpisu webhook dla środowiska review i ewentualnie dodać tryb kompatybilny.

## Etap 3 — Pakiet submission

7. Przygotować finalne treści listingowe, kontakt support, polityki prawne i instrukcję dla testera.
8. Dodać checklistę testów manualnych (instalacja, konfiguracja, webhooki, awarie, odinstalowanie).
9. Ujednolicić dokumentację repo z rzeczywistym stanem wdrożenia.

## 5) Wniosek

Na dziś aplikacja ma solidny fundament integracyjny (webhooki, walidacja, konfiguracja, persistencja), ale **nie jest jeszcze gotowa do formalnego oddania na testy Shoper App Store** bez domknięcia blokad jakościowych (kompilacja/testy), formalnych (pakiet submission) i instalacyjnych (flow app lifecycle).

