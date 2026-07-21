export function errorTitle(status: number): string {
  switch (status) {
    case 404: return 'Page Not Found';
    case 403: return 'Access Denied';
    case 500: return 'Server Error';
    default: return 'Something Went Wrong';
  }
}

export function errorIcon(status: number): string {
  switch (status) {
    case 404: return '🔍';
    case 403: return '🔒';
    case 500: return '⚠️';
    default: return '❌';
  }
}
