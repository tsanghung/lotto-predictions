import { createApp } from 'vue'
import './style.css'
import App from './App.vue'

function injectStructuredData() {
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': 'https://lotto.simonsynapse.net/#website',
        url: 'https://lotto.simonsynapse.net/',
        name: '小賽 AI 樂透預測',
        inLanguage: 'zh-Hant-TW',
        description: '整合 Gemini AI、台灣彩券歷史開獎資料、統計特徵、回測與命中追蹤的樂透預測儀表板。',
        publisher: {
          '@id': 'https://lotto.simonsynapse.net/#organization',
        },
      },
      {
        '@type': 'Organization',
        '@id': 'https://lotto.simonsynapse.net/#organization',
        name: '小賽 AI 樂透預測',
        url: 'https://lotto.simonsynapse.net/',
        logo: 'https://lotto.simonsynapse.net/favicon.svg',
        sameAs: ['https://github.com/tsanghung/lotto-predictions'],
      },
      {
        '@type': 'WebApplication',
        '@id': 'https://lotto.simonsynapse.net/#app',
        name: '小賽 AI 樂透預測',
        url: 'https://lotto.simonsynapse.net/',
        applicationCategory: 'DataVisualizationApplication',
        operatingSystem: 'Web',
        inLanguage: 'zh-Hant-TW',
        description: '提供大樂透、今彩539、威力彩的 AI 選號、統計分析、歷史回測與成效追蹤。',
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'TWD',
        },
      },
    ],
  }

  const script = document.createElement('script')
  script.type = 'application/ld+json'
  script.textContent = JSON.stringify(structuredData)
  document.head.appendChild(script)
}

injectStructuredData()
createApp(App).mount('#app')
