import Link from 'next/link';
import { listCanon, listSchemes, type CanonBookRow } from '@/lib/queries';
import { NewProjectForm } from './form';

export default async function NewProjectPage() {
  const schemes = await listSchemes();
  const usable = schemes.filter((s) => s.usable);

  // The canon is fetched per usable scheme so the book list can change with the
  // selection without a round trip. There are two schemes registered and one
  // seeded, so this is two queries at most — worth it to keep the form static.
  const canonByScheme: Record<string, CanonBookRow[]> = {};
  await Promise.all(
    usable.map(async (s) => {
      canonByScheme[s.code] = await listCanon(s.code);
    }),
  );

  return (
    <>
      <p className="breadcrumb">
        <Link href="/projects">Projects</Link> / New
      </p>
      <div className="page-head">
        <h1>New project</h1>
        <p>
          Two of these choices are permanent. The versification scheme cannot be changed after
          creation — it decides how many verses each chapter has, and a wrong choice surfaces at
          export, long after translation has started. The language code and script code drive font
          selection and text direction in the app.
        </p>
      </div>

      {usable.length === 0 ? (
        <div className="card">
          <p className="notice error">
            No versification scheme has any verse-count data seeded, so no project can be created.
            Load <code>ref.versification</code> in the database repository first.
          </p>
        </div>
      ) : (
        <NewProjectForm
          schemes={schemes}
          canonByScheme={canonByScheme}
          defaultScheme={usable.some((s) => s.code === 'eng') ? 'eng' : (usable[0]?.code ?? '')}
        />
      )}
    </>
  );
}
