import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '英语听力练习',
  description: 'AI 生成、听音作答与即时复盘',
  lang: 'zh-CN',
  cleanUrls: true,
  vite: {
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true
        }
      }
    }
  },
  themeConfig: {
    nav: [{ text: '听力练习', link: '/listening' }],
    sidebar: [{ text: '听力练习', link: '/listening' }]
  }
})
