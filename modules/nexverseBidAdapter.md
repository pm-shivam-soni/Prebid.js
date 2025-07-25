# Nexverse Bid Adapter

## Overview
The Nexverse Bid Adapter enables publishers to connect with the Nexverse Real-Time Bidding (RTB) platform. This adapter supports multiple ad formats, including Banner, Video, and Native ads. By integrating this adapter, publishers can send bid requests to Nexverse’s marketplace and receive high-quality ads in response.

- **Module name**: Nexverse
- **Module type**: Bidder Adapter
- **Supported Media Types**: Banner, Video, Native
- **Maintainer**: anand.kumar@nexverse.ai

## Bidder Parameters
To correctly configure the Nexverse Bid Adapter, the following parameters are required:

| Param Name   | Scope    | Type   | Description                                         |
|--------------|----------|--------|-----------------------------------------------------|
| `uid`        | required | string | Unique User ID assigned by Nexverse for the publisher |
| `pubId`     | required | string | The unique ID for the publisher                     |
| `pubEpid`   | required | string | The unique endpoint ID for the publisher            |
| `bidFloor`  | optional | float  | Bid Floor for bid request                           |
| `yob`       | optional | int    | Year of birth as a 4-digit integer                  |
| `gender`    | optional | string | Gender, where “M” = male, “F” = female, “O” = known to be other (i.e., omitted is unknown) |
| `keywords`  | optional | float  | Comma separated list of current page keywords, interests, or intent |

### Example Configuration
The following is an example configuration for a Nexverse bid request using Prebid.js:

```javascript
var adUnits = [{
  code: 'div-gpt-ad-1460505748561-0',
  mediaTypes: {
    banner: {
      sizes: [[300, 250], [300, 600]]
    }
  },
  bids: [{
    bidder: 'nexverse',
    params: {
      uid: '12345',
      pubId: '54321',
      pubEpid: 'abcde',
      bidFloor: 0.10,
      yob: 1996,
      gender: 'M',
      keywords: 'sports,entertainment,politics'
    },
    isDebug: false // Optional, i.e True for debug mode
  }]
}];
```
