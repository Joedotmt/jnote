import adapter from '@sveltejs/adapter-static';

const isDevelopment = process.argv.includes('dev');
const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const productionBase = process.env.BASE_PATH
  ?? (process.env.GITHUB_ACTIONS === 'true' && repositoryName ? `/${repositoryName}` : '');

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      fallback: '404.html'
    }),
    paths: {
      base: isDevelopment ? '' : productionBase
    }
  }
};

export default config;
