import { Migration } from '@mikro-orm/migrations';

export class Migration20261101000000_init extends Migration {
  override name = 'Migration20261101000000_init';

  override up(): void {
    this.addSql('create extension if not exists pgcrypto;');
  }

  override down(): void {
    this.addSql('drop extension if exists pgcrypto;');
  }
}
