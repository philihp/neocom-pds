'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { finishBinding } from './actions'

const FORM_ID = 'finish-binding'

interface Props {
  characterId: number
  handle: string
  pdsUrl: string
}

export const PasswordForm = ({ characterId, handle, pdsUrl }: Props) => {
  const [hasValue, setHasValue] = useState(false)
  return (
    <>
      <Image
        src={`https://images.evetech.net/characters/${characterId}/portrait?size=256`}
        alt={handle}
        width={128}
        height={128}
      />
      <dl>
        <dt>Host</dt>
        <dd>
          <code>{pdsUrl}</code>
        </dd>
        <dt>Username</dt>
        <dd>
          <code>
            <Link href={`https://bsky.app/profile/${handle}`}>{handle}</Link>
          </code>
        </dd>
        <dt>Password</dt>
        <dd>
          <form id={FORM_ID} action={finishBinding}>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              onChange={(e) => setHasValue(e.target.value.length > 0)}
            />
          </form>
        </dd>
      </dl>
      <button type="submit" form={FORM_ID} disabled={!hasValue}>
        Confirm Link
      </button>
    </>
  )
}
