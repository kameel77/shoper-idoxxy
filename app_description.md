# Shoper ↔ Idoxxy Integration

## Overview

A Node.js-based server application that integrates Shoper e-commerce platform with Idoxxy document management system. The integration enables automatic synchronization of customer data and document delivery through webhook-based event processing.

## Architecture

### Core Components

- **Express Server** with TypeScript
- **Webhook Handlers** for real-time Shoper event processing
- **REST API** for configuration and management
- **In-Memory Repository** for settings and sync tracking
- **Client Libraries** for Shoper and Idoxxy API communication

### Key Technologies

- **Runtime**: Node.js ≥18
- **Language**: TypeScript
- **Framework**: Express.js
- **Validation**: Zod schemas
- **Security**: Helmet, CORS, input validation
- **Authentication**: OAuth2 + API keys

## Features

### ✅ Implemented Features

#### 1. API Connection Management
- Idoxxy API credentials storage (Base URL, API Key)
- Connection testing and validation
- OAuth2 token management with automatic refresh
- Token-first linking per shop (Shoper shop → Idoxxy workspace/token) z testem `/details/me`

#### 2. Customer Group Management
- Dynamic group synchronization from Idoxxy
- Fallback group configuration for different event types
- Customer assignment to multiple groups

#### 3. Event Mapping System
- Configurable rules for Shoper events (`customer.created`, `order.created`)
- Priority-based rule processing
- Conditional mapping with field-based filters
- Target group assignment with fallback support

#### 4. Webhook Processing
- Secure webhook signature verification
- Real-time processing of customer registrations and orders
- Automatic customer creation/lookup in Idoxxy
- Group assignment based on mapping rules
- Shop context derived from webhook headers (`X-Shoper-Shop-Id`/`X-Shop-Id`/`X-Shop`/`X-Shop-Url`) or `shop_id` in payload; missing link → HTTP 428

#### 5. Synchronization Tracking
- Comprehensive audit logging of all sync operations
- Success/failure status tracking with detailed error information
- Processing time measurement and performance monitoring
- Complete history with timestamps and metadata

#### 6. Administrative Interface
- Web-based settings panel (`/settings`)
- Real-time configuration updates
- Connection status monitoring
- Mapping rule management
- Sync history and statistics viewing

#### 7. REST API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Landing page |
| GET | `/settings` | Settings panel |
| GET | `/settings/config` | Current configuration |
| PUT | `/settings/credentials` | Update API credentials |
| PUT | `/settings/default-groups` | Configure fallback groups |
| POST | `/settings/mappings` | Create/update mapping rules |
| DELETE | `/settings/mappings/:id` | Delete mapping rule |
| GET | `/settings/groups` | List available Idoxxy groups |
| GET | `/settings/documents` | List available documents |
| GET | `/settings/sync-logs` | View sync operation history |
| GET | `/settings/sync-stats` | Get sync statistics |
| GET | `/settings/test-connection` | Test Idoxxy API connection |
| GET | `/settings/test-shoper` | Test Shoper API connection |
| POST | `/settings/link/test` | Validate Idoxxy token for a shop |
| POST | `/settings/link` | Save shop→workspace/token mapping |
| GET | `/settings/link/status/:shopId` | Get link status for a shop |
| GET | `/settings/link/connections` | List all saved connections |
| POST | `/webhooks/shoper/customer-created` | Process customer registration |
| POST | `/webhooks/shoper/order-created` | Process order creation |

### 🔄 Synchronization Flow

1. **Event Reception**: Shoper sends webhook with customer/order data
2. **Signature Verification**: Validates webhook authenticity
3. **Data Validation**: Ensures payload structure and required fields
4. **Mapping Resolution**: Applies configured rules to determine target groups
5. **Customer Processing**: Creates or finds customer in Idoxxy system
6. **Group Assignment**: Assigns customer to appropriate groups
7. **Audit Logging**: Records operation details and status
8. **Response**: Returns success/failure with processing details

### 📊 Tracking & Monitoring

#### Sync Log Details
- **Timestamp**: When operation occurred
- **Event Type**: Shoper event that triggered sync
- **Status**: Success, error, or partial success
- **Processing Time**: Duration of operation
- **Customer Info**: Idoxxy customer ID and email
- **Mapping Used**: Which rule was applied
- **Groups Assigned**: Target groups for the customer
- **Error Details**: Failure reasons and context

#### Statistics Available
- Total operations count
- Success/error rates
- Last sync timestamp
- Performance metrics

## Configuration

### Environment Variables
```bash
PORT=3000
IDOXXY_API_KEY=your_api_key
IDOXXY_CLIENT_ID=your_client_id
IDOXXY_CLIENT_SECRET=your_client_secret
IDOXXY_BASE_URL=https://api.idoxxy.com
SHOPER_CLIENT_ID=your_shoper_client_id
SHOPER_CLIENT_SECRET=your_shoper_client_secret
SHOPER_WEBHOOK_SECRET=your_webhook_secret
```

### Settings Structure
- **API Credentials**: Base URL and authentication tokens
- **Default Groups**: Fallback groups for unmapped events
- **Event Mappings**: Configurable rules with conditions and priorities
- **Sync History**: Automatic logging of all operations

## Security Features

- **Input Validation**: Comprehensive Zod schemas for all inputs
- **Webhook Verification**: HMAC signature validation for Shoper webhooks
- **CORS Protection**: Restricted cross-origin requests
- **Helmet Security Headers**: XSS and injection protection
- **Rate Limiting**: Built-in request throttling
- **Error Handling**: Safe error responses without data leakage

## Development & Deployment

### Prerequisites
- Node.js ≥18
- npm or yarn
- Valid Idoxxy API credentials
- Shoper store with webhook configuration

### Installation
```bash
npm install
npm run build
npm start
```

### Development
```bash
npm run dev  # With ts-node for development
```

### Production
```bash
npm run build
npm start
```

## Monitoring & Troubleshooting

### Log Analysis
- Check sync logs via `/settings/sync-logs` endpoint
- Monitor error rates and performance metrics
- Review mapping rule effectiveness

### Common Issues
- **Webhook Signature Failures**: Verify `SHOPER_WEBHOOK_SECRET`
- **API Connection Errors**: Check credentials and network connectivity
- **Mapping Not Applied**: Review event names and conditions
- **Group Assignment Failures**: Verify group IDs exist in Idoxxy

### Performance Considerations
- In-memory storage suitable for moderate loads
- Automatic log cleanup prevents memory issues
- Efficient webhook processing with async operations
- Configurable retry logic for API failures

## Future Enhancements

### Potential Additions
- Persistent storage (SQLite/PostgreSQL)
- Advanced retry and queue mechanisms
- Bulk operations for large customer sets
- Document delivery automation
- Advanced conditional mapping with expressions
- Integration monitoring dashboard
- Email notifications for sync failures
- API rate limiting and throttling
- Multi-tenant support

---

**Status**: ✅ Fully functional with comprehensive synchronization tracking
**Last Updated**: December 2025
**Version**: 1.0.0
